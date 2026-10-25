import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.NXY_DATA_DIR || path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(path.join(dataDir, 'nxy.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL, email TEXT NOT NULL UNIQUE, passhash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'collector', active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL, price TEXT NOT NULL, category TEXT NOT NULL, image TEXT NOT NULL, tag TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, owner_id INTEGER REFERENCES users(id), created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bids(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), user_id INTEGER NOT NULL REFERENCES users(id), amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Active', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sales(id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id), buyer_id INTEGER REFERENCES users(id), amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'Recorded', tx_hash TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS account_balances(user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, balance REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS deposit_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, amount REAL NOT NULL, tx_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', created TEXT NOT NULL, reviewed TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS mint_requests(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, description TEXT NOT NULL, image_url TEXT NOT NULL, price REAL NOT NULL, category TEXT NOT NULL DEFAULT 'Art', status TEXT NOT NULL DEFAULT 'Pending', tx_hash TEXT NOT NULL DEFAULT '', item_id INTEGER REFERENCES items(id), created TEXT NOT NULL, reviewed TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS favorites(user_id INTEGER NOT NULL REFERENCES users(id), item_id INTEGER NOT NULL REFERENCES items(id), created TEXT NOT NULL, PRIMARY KEY(user_id,item_id));
CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), message TEXT NOT NULL, amount TEXT NOT NULL DEFAULT '', item_id INTEGER, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS subscribers(email TEXT PRIMARY KEY, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
for (const [column,definition] of [['collection_name',"TEXT NOT NULL DEFAULT ''"],['supply','INTEGER NOT NULL DEFAULT 1'],['royalty','REAL NOT NULL DEFAULT 5'],['sale_type',"TEXT NOT NULL DEFAULT 'Fixed price'"],['wallet_address',"TEXT NOT NULL DEFAULT ''"]]) {
 if (!db.prepare('PRAGMA table_info(mint_requests)').all().some(row=>row.name===column)) db.exec(`ALTER TABLE mint_requests ADD COLUMN ${column} ${definition}`);
}
db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
const initialItems = [
 ['Prismatic Bloom','Mira Sol','1.84','Art','photo-1531058020387-3be344556be6','ENDING SOON'],
 ['Dream Sequence 04','Studio KAI','2.40','3D','photo-1634017839464-5c339ebe3cb4','FEATURED'],
 ['Soft Machines','Noah Reyes','0.92','Collectibles','photo-1634986666676-ec8fd927c23d','NEW DROP'],
 ['After the Sun','Luna Fields','3.18','Art','photo-1549490349-8643362247b5','NXY PICK'],
 ['Future Relic 09','Mira Sol','1.22','Collectibles','photo-1618005182384-a83a8bd57fbe','ON AUCTION'],
 ['Otherworldly','Ari Voss','4.06','3D','photo-1618172193763-c511deb635ca','RARE'],
 ['Chromatic Drift','K. Tanaka','0.78','Art','photo-1543857778-c4a1a3e0b2eb','JUST LISTED'],
 ['Tiny Universe #41','PxlGarden','0.56','Collectibles','photo-1633167606207-d840b5070fc2','COLLECTIBLE']
];

const settingDefaults = { announcement:'The next era of collecting is here', headline:'Collect what comes next.', intro:'Step into a universe where creativity has no gravity. Discover rare digital art, meet the minds behind it, and make the next iconic piece yours.', siteActive:true, biddingActive:true, newsletterActive:true, rankingsActive:true, royalty:'5', featured:'Art', creatorApps:true, walletEnabled:false, mintingEnabled:true, purchasesEnabled:false, depositNetwork:'', depositAsset:'ETH', depositAddress:'' };
for (const [key,value] of Object.entries(settingDefaults)) db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value));

const hash = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const cookieName = 'nxy_session';
const sessions = db.prepare('SELECT s.*,u.id,u.username,u.email,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>?');
const loginAttempts = new Map();
const mime = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.json':'application/json; charset=utf-8' };

function send(res,status,data,headers={}) { res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...headers});res.end(JSON.stringify(data)); }
function getCookie(req,name){return (req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1)||'';}
function sessionFor(req){const token=getCookie(req,cookieName);if(!token)return null;const s=sessions.get(hash(decodeURIComponent(token)),Date.now());if(!s||!s.active){if(s)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(decodeURIComponent(token)));return null;}return s;}
function requireUser(req,res){const s=sessionFor(req);if(!s){send(res,401,{error:'Sign in to continue.'});return null;}return s;}
function requireAdmin(req,res){const s=requireUser(req,res);if(s&&s.role!=='admin'){send(res,403,{error:'Administrator access required.'});return null;}return s;}
async function body(req,maxBytes=65536){let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>maxBytes)throw new Error('Request too large.');}try{return JSON.parse(raw||'{}')}catch{throw new Error('Invalid request body.');}}
function csrfOk(req,session){return req.headers['x-csrf-token']===session.csrf;}
function rateLimit(req,res,key){const ip=req.socket.remoteAddress||'unknown',k=ip+':'+key,record=loginAttempts.get(k)||{start:Date.now(),count:0};if(Date.now()-record.start>15*60*1000){record.start=Date.now();record.count=0;}record.count++;loginAttempts.set(k,record);if(record.count>12){send(res,429,{error:'Too many attempts. Try again in 15 minutes.'});return false;}return true;}
function getSettings(){return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(x=>[x.key,JSON.parse(x.value)]));}
function setSettings(settings){const stmt=db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');for(const [k,v] of Object.entries(settings))stmt.run(k,JSON.stringify(v));}
function userSummary(s){return {id:s.id,username:s.username,email:s.email,role:s.role};}
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/api/health')return send(res,200,{ok:true});
  if(url.pathname.startsWith('/api/')&&req.method!=='GET'&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)return send(res,403,{error:'Origin not allowed.'});
  if(req.method==='GET'&&url.pathname==='/api/marketplace'){
   const settings=getSettings();const items=db.prepare('SELECT i.id,i.name,i.artist,COALESCE((SELECT max(b.amount) FROM bids b WHERE b.item_id=i.id),CAST(i.price AS REAL)) AS price,i.category AS cat,i.image AS img,i.tag,i.active,(SELECT count(*) FROM bids b WHERE b.item_id=i.id) AS bids FROM items i WHERE i.active=1 ORDER BY i.id DESC').all();const creators=db.prepare('SELECT artist AS name,count(*) AS listings FROM items WHERE active=1 GROUP BY artist ORDER BY listings DESC,artist LIMIT 6').all();const metrics={collectors:db.prepare('SELECT count(*) AS n FROM users').get().n,activeListings:items.length,bidVolume:db.prepare('SELECT COALESCE(sum(amount),0) AS n FROM bids').get().n};
   return send(res,200,{settings,items,creators,metrics});
  }
  if(req.method==='GET'&&url.pathname==='/api/session'){
   const s=sessionFor(req),setup=db.prepare("SELECT count(*) AS n FROM users WHERE role='admin'").get().n===0,adminSetupAvailable=setup&&(process.env.NXY_ADMIN_SETUP_KEY||'').length>=32;return send(res,200,{authenticated:!!s,user:s?userSummary(s):null,csrf:s?.csrf||null,setup,adminSetupAvailable});
  }
  if(req.method==='POST'&&url.pathname==='/api/newsletter'){
   const input=await body(req),email=String(input.email||'').trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter a valid email address.'});db.prepare('INSERT OR IGNORE INTO subscribers(email,created) VALUES(?,?)').run(email,now());return send(res,201,{ok:true});
  }
  if(req.method==='POST'&&url.pathname==='/api/admin/setup'){
   if(!rateLimit(req,res,url.pathname))return;
   const setupKey=process.env.NXY_ADMIN_SETUP_KEY||'';
   if(setupKey.length<32)return send(res,503,{error:'Private administrator setup is not configured.'});
   const input=await body(req),providedKey=String(input.setupKey||''),email=String(input.email||'').trim().toLowerCase(),username=String(input.username||'').trim(),password=String(input.password||'');
   const suppliedHash=createHash('sha256').update(providedKey).digest(),expectedHash=createHash('sha256').update(setupKey).digest();
   if(!timingSafeEqual(suppliedHash,expectedHash))return send(res,401,{error:'Setup key is incorrect.'});
   if(username.length<2||username.length>40||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||password.length>200)return send(res,400,{error:'Enter a display name, valid email, and password of at least 12 characters.'});
   db.exec('BEGIN IMMEDIATE');
   try{
    if(db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get()){db.exec('ROLLBACK');return send(res,410,{error:'Administrator setup has already been completed.'});}
    const salt=randomBytes(16).toString('hex'),passhash=scryptSync(password,salt,64).toString('hex');
    const result=db.prepare("INSERT INTO users(username,email,passhash,salt,role,created) VALUES(?,?,?,?, 'admin', ?)").run(username,email,passhash,salt,now());
    const user=db.prepare('SELECT id,username,email,role,active FROM users WHERE id=?').get(result.lastInsertRowid);
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expires=Date.now()+30*24*60*60*1000;
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(hash(token),user.id,csrf,expires);
    db.exec('COMMIT');
    const secureCookie=process.env.NODE_ENV==='production'?'; Secure':'';
    return send(res,201,{user:userSummary(user),csrf},{'set-cookie':`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secureCookie}`});
   }catch(error){db.exec('ROLLBACK');if(String(error.message).includes('UNIQUE'))return send(res,409,{error:'An account with this email already exists.'});throw error;}
  }
  if(req.method==='POST'&&['/api/signup','/api/login','/api/admin/login'].includes(url.pathname)){
   if(!rateLimit(req,res,url.pathname))return;
   const input=await body(req),email=String(input.email||'').trim().toLowerCase(),password=String(input.password||''),username=String(input.username||'').trim();
   if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<10||password.length>200)return send(res,400,{error:'Enter a valid email and a password of at least 10 characters.'});
   let user;
   if(url.pathname==='/api/signup'){
    if(username.length<2||username.length>40)return send(res,400,{error:'Choose a display name between 2 and 40 characters.'});
    const salt=randomBytes(16).toString('hex'),passhash=scryptSync(password,salt,64).toString('hex');
    try{const result=db.prepare('INSERT INTO users(username,email,passhash,salt,role,created) VALUES(?,?,?,?,?,?)').run(username,email,passhash,salt,'collector',now());user=db.prepare('SELECT id,username,email,role,active FROM users WHERE id=?').get(result.lastInsertRowid);}catch(e){if(String(e.message).includes('UNIQUE'))return send(res,409,{error:'An account with this email already exists.'});throw e;}
   }else{
    user=db.prepare('SELECT id,username,email,role,active,passhash,salt FROM users WHERE email=?').get(email);const candidate=user?scryptSync(password,user.salt,64):scryptSync(password,'nxy-invalid-user-salt',64);const expected=Buffer.from(user?.passhash||'0'.repeat(128),'hex');if(candidate.length!==expected.length||!timingSafeEqual(candidate,expected)||!user||!user.active)return send(res,401,{error:'Email or password is incorrect.'});if(url.pathname==='/api/login'&&user.role==='admin')return send(res,403,{error:'Administrators must use the private administrator sign-in.'});if(url.pathname==='/api/admin/login'&&user.role!=='admin')return send(res,403,{error:'Administrator access required.'});
   }
   const token=randomBytes(32).toString('base64url'),csrf=randomBytes(24).toString('base64url'),expires=Date.now()+30*24*60*60*1000;db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(hash(token),user.id,csrf,expires);
   const secureCookie=process.env.NODE_ENV==='production'?'; Secure':'';
   return send(res,200,{user:userSummary(user),csrf}, {'set-cookie':`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secureCookie}`});
  }
  if(req.method==='POST'&&url.pathname==='/api/logout'){
   const s=requireUser(req,res);if(!s)return;if(!csrfOk(req,s))return send(res,403,{error:'Session check failed.'});db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(decodeURIComponent(getCookie(req,cookieName))));return send(res,200,{ok:true},{'set-cookie':`${cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`});
  }
  if(req.method==='GET'&&url.pathname==='/api/dashboard'){
   const s=requireUser(req,res);if(!s)return;
   const bids=db.prepare('SELECT b.id,b.amount,b.status,b.created,i.name,i.image AS img FROM bids b JOIN items i ON i.id=b.item_id WHERE b.user_id=? ORDER BY b.id DESC LIMIT 10').all(s.id);
   const favorites=db.prepare('SELECT i.id,i.name,i.artist,i.price,i.category AS cat,i.image AS img,i.tag FROM favorites f JOIN items i ON i.id=f.item_id WHERE f.user_id=? ORDER BY f.created DESC').all(s.id);
   const activityRows=db.prepare('SELECT message,amount,created FROM activity WHERE user_id=? ORDER BY id DESC LIMIT 12').all(s.id);
   const listings=db.prepare('SELECT id,name,price,category AS cat,image AS img,active FROM items WHERE owner_id=? ORDER BY id DESC').all(s.id);
   const balance=db.prepare('SELECT balance FROM account_balances WHERE user_id=?').get(s.id)?.balance||0;
   const deposits=db.prepare('SELECT id,amount,tx_hash AS txHash,status,created FROM deposit_requests WHERE user_id=? ORDER BY id DESC LIMIT 20').all(s.id);
   const mints=db.prepare('SELECT id,title,description,image_url AS imageUrl,price,category,status,tx_hash AS txHash,created FROM mint_requests WHERE user_id=? ORDER BY id DESC LIMIT 20').all(s.id);
   return send(res,200,{user:userSummary(s),bids,favorites,activity:activityRows,listings,balance,deposits,mints,settings:getSettings(),csrf:s.csrf});
  }
  if(req.method==='POST'&&url.pathname.startsWith('/api/')){
   const s=requireUser(req,res);if(!s)return;if(!csrfOk(req,s))return send(res,403,{error:'Session check failed.'});const input=await body(req,url.pathname==='/api/mint-requests'?6_500_000:65536);
   if(url.pathname==='/api/favorites'){
    const id=Number(input.itemId);if(!db.prepare('SELECT id FROM items WHERE id=? AND active=1').get(id))return send(res,404,{error:'Listing not found.'});const found=db.prepare('SELECT 1 FROM favorites WHERE user_id=? AND item_id=?').get(s.id,id);if(found)db.prepare('DELETE FROM favorites WHERE user_id=? AND item_id=?').run(s.id,id);else db.prepare('INSERT INTO favorites(user_id,item_id,created) VALUES(?,?,?)').run(s.id,id,now());return send(res,200,{favorite:!found});
   }
   if(url.pathname==='/api/bids'){
     if(getSettings().biddingActive===false)return send(res,403,{error:'Bidding is currently paused.'});const id=Number(input.itemId),amount=Number(input.amount),item=db.prepare('SELECT * FROM items WHERE id=? AND active=1').get(id);if(!item)return send(res,404,{error:'Listing not found.'});const topBid=db.prepare('SELECT max(amount) AS top FROM bids WHERE item_id=?').get(id).top,current=topBid===null?Number(item.price):Number(topBid);if(!Number.isFinite(amount)||amount<=current||amount>1000000)return send(res,400,{error:`Enter a bid above ${current} ETH.`});
    db.prepare('INSERT INTO bids(item_id,user_id,amount,created) VALUES(?,?,?,?)').run(id,s.id,amount,now());db.prepare('INSERT INTO activity(user_id,message,amount,item_id,created) VALUES(?,?,?,?,?)').run(s.id,`Placed a bid on ${item.name}`,amount.toFixed(3)+' ETH',id,now());return send(res,201,{ok:true,message:'Bid recorded in the NXY marketplace.'});
   }
   if(url.pathname==='/api/deposits'){
    const settings=getSettings();if(settings.walletEnabled!==true||!settings.depositAddress)return send(res,403,{error:'Deposits are not configured by the administrator yet.'});const amount=Number(input.amount),txHash=String(input.txHash||'').trim();if(!Number.isFinite(amount)||amount<=0||amount>1000000||txHash.length<8||txHash.length>160)return send(res,400,{error:'Enter a valid amount and transaction reference.'});const result=db.prepare('INSERT INTO deposit_requests(user_id,amount,tx_hash,created) VALUES(?,?,?,?)').run(s.id,amount,txHash,now());db.prepare('INSERT INTO activity(user_id,message,amount,created) VALUES(?,?,?,?)').run(s.id,'Submitted a deposit for verification',amount.toFixed(3)+' '+String(settings.depositAsset||'ETH'),now());return send(res,201,{ok:true,id:result.lastInsertRowid,message:'Deposit submitted. Your balance updates after an administrator verifies it.'});
   }
   if(url.pathname==='/api/mint-requests'){
    if(getSettings().mintingEnabled!==true)return send(res,403,{error:'Mint requests are not open yet.'});const title=String(input.title||'').trim(),description=String(input.description||'').trim(),imageUrl=String(input.imageUrl||'').trim(),collectionName=String(input.collectionName||'').trim(),walletAddress=String(input.walletAddress||'').trim(),price=Number(input.price),supply=Number(input.supply||1),royalty=Number(input.royalty??5),saleType=['Fixed price','Auction','Not for sale'].includes(input.saleType)?input.saleType:'Fixed price',category=['Art','Collectibles','3D'].includes(input.category)?input.category:'Art';let parsed;try{parsed=new URL(imageUrl)}catch{}const imageOk=(parsed&&['https:','http:'].includes(parsed.protocol))||/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(imageUrl);if(title.length<2||title.length>80||description.length>1000||!imageOk||imageUrl.length>6_000_000||collectionName.length<2||collectionName.length>80||!Number.isInteger(supply)||supply<1||supply>10000||!Number.isFinite(royalty)||royalty<0||royalty>20||!Number.isFinite(price)||price<0||price>1000000)return send(res,400,{error:'Complete the collection, artwork, and sale details with valid values.'});const result=db.prepare('INSERT INTO mint_requests(user_id,title,description,image_url,price,category,created,collection_name,supply,royalty,sale_type,wallet_address) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id,title,description,imageUrl,price,category,now(),collectionName,supply,royalty,saleType,walletAddress);db.prepare('INSERT INTO activity(user_id,message,created) VALUES(?,?,?)').run(s.id,`Submitted an NFT mint request: ${title}`,now());return send(res,201,{ok:true,id:result.lastInsertRowid,message:'Mint request sent to the admin queue.'});
   }
   if(url.pathname==='/api/profile'){
    const username=String(input.username||'').trim();if(username.length<2||username.length>40)return send(res,400,{error:'Display name must be 2–40 characters.'});db.prepare('UPDATE users SET username=? WHERE id=?').run(username,s.id);return send(res,200,{ok:true,username});
   }
   if(url.pathname==='/api/listings'){
    const name=String(input.name||'').trim(),price=Number(input.price),category=['Art','Collectibles','3D'].includes(input.category)?input.category:'Art';if(name.length<2||name.length>80||!Number.isFinite(price)||price<=0)return send(res,400,{error:'Enter a title and a price above zero.'});const result=db.prepare('INSERT INTO items(name,artist,price,category,image,tag,active,owner_id,created) VALUES(?,?,?,?,?,?,?,?,?)').run(name,s.username,price.toFixed(3),category,'photo-1618005182384-a83a8bd57fbe','NEW CREATION',1,s.id,now());db.prepare('INSERT INTO activity(user_id,message,created) VALUES(?,?,?)').run(s.id,`Created a listing: ${name}`,now());return send(res,201,{ok:true,id:result.lastInsertRowid});
   }
   if(url.pathname==='/api/listings/manage'){
    const id=Number(input.id),active=input.active?1:0;const item=db.prepare('SELECT id FROM items WHERE id=? AND owner_id=?').get(id,s.id);if(!item)return send(res,404,{error:'Your listing was not found.'});db.prepare('UPDATE items SET active=? WHERE id=? AND owner_id=?').run(active,id,s.id);return send(res,200,{ok:true});
   }
   if(url.pathname.startsWith('/api/admin/')){
    if(s.role!=='admin')return send(res,403,{error:'Administrator access required.'});
     if(url.pathname==='/api/admin/settings'){const next=input.settings||{};const allowed=['announcement','headline','intro','siteActive','biddingActive','newsletterActive','rankingsActive','royalty','featured','creatorApps','walletEnabled','mintingEnabled','purchasesEnabled','depositNetwork','depositAsset','depositAddress'];const patch=Object.fromEntries(allowed.filter(k=>k in next).map(k=>[k,next[k]]));setSettings(patch);return send(res,200,{ok:true,settings:getSettings()});}
    if(url.pathname==='/api/admin/items'){if(input.action==='create'){const name=String(input.name||'').trim(),artist=String(input.artist||'NXY Creator').trim(),price=Number(input.price);if(name.length<2||name.length>80||!Number.isFinite(price)||price<=0)return send(res,400,{error:'Enter a title and a price above zero.'});const cat=['Art','Collectibles','3D'].includes(input.category)?input.category:'Art';const result=db.prepare('INSERT INTO items(name,artist,price,category,image,tag,active,created) VALUES(?,?,?,?,?,?,1,?)').run(name,artist,price.toFixed(3),cat,'photo-1618005182384-a83a8bd57fbe','NEW DROP',now());return send(res,201,{ok:true,id:result.lastInsertRowid});}const id=Number(input.id);if(input.action==='delete'){db.prepare('UPDATE items SET active=0 WHERE id=?').run(id);return send(res,200,{ok:true});}const changes={};for(const k of ['name','artist','price','tag'])if(k in input)changes[k]=String(input[k]).slice(0,100);if('active'in input)changes.active=input.active?1:0;if(!Object.keys(changes).length)return send(res,400,{error:'No changes provided.'});db.prepare(`UPDATE items SET ${Object.keys(changes).map(k=>`${k}=?`).join(',')} WHERE id=?`).run(...Object.values(changes),id);return send(res,200,{ok:true});}
    if(url.pathname==='/api/admin/users'){const id=Number(input.id);if(id===s.id)return send(res,400,{error:'You cannot suspend your own administrator account.'});const target=db.prepare('SELECT role FROM users WHERE id=?').get(id);if(!target||target.role==='admin')return send(res,400,{error:'Only collector accounts can be suspended here.'});db.prepare('UPDATE users SET active=? WHERE id=?').run(input.active?1:0,id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);return send(res,200,{ok:true});}
     if(url.pathname==='/api/admin/transactions'){
      const kind=input.kind==='sale'?'sale':'bid',action=input.action||'update',id=Number(input.id);
      if(kind==='bid'){
       if(action==='delete'){db.prepare('DELETE FROM bids WHERE id=?').run(id);return send(res,200,{ok:true});}
       const amount=Number(input.amount),status=String(input.status||'Active').slice(0,30);if(!Number.isFinite(amount)||amount<=0)return send(res,400,{error:'Enter an amount above zero.'});
       const result=db.prepare('UPDATE bids SET amount=?,status=? WHERE id=?').run(amount,status,id);if(!result.changes)return send(res,404,{error:'Bid record not found.'});return send(res,200,{ok:true});
      }
      if(action==='delete'){db.prepare('DELETE FROM sales WHERE id=?').run(id);return send(res,200,{ok:true});}
      if(action==='create'){
       const itemId=Number(input.itemId),amount=Number(input.amount),buyerId=input.buyerId?Number(input.buyerId):null,status=String(input.status||'Recorded').slice(0,30),txHash=String(input.txHash||'').slice(0,160);
       if(!db.prepare('SELECT id FROM items WHERE id=?').get(itemId)||!Number.isFinite(amount)||amount<=0)return send(res,400,{error:'Choose a listing and enter an amount above zero.'});
       if(buyerId&&!db.prepare('SELECT id FROM users WHERE id=?').get(buyerId))return send(res,400,{error:'Buyer account not found.'});
       db.prepare('INSERT INTO sales(item_id,buyer_id,amount,status,tx_hash,created) VALUES(?,?,?,?,?,?)').run(itemId,buyerId,amount,status,txHash,now());return send(res,201,{ok:true});
      }
      const amount=Number(input.amount),status=String(input.status||'Recorded').slice(0,30),txHash=String(input.txHash||'').slice(0,160);if(!Number.isFinite(amount)||amount<=0)return send(res,400,{error:'Enter an amount above zero.'});
      const result=db.prepare('UPDATE sales SET amount=?,status=?,tx_hash=? WHERE id=?').run(amount,status,txHash,id);if(!result.changes)return send(res,404,{error:'Sale record not found.'});return send(res,200,{ok:true});
     }
     if(url.pathname==='/api/admin/deposits'){
      const id=Number(input.id),status=input.status==='Approved'?'Approved':'Rejected';db.exec('BEGIN IMMEDIATE');try{const request=db.prepare('SELECT user_id,amount,status FROM deposit_requests WHERE id=?').get(id);if(!request){db.exec('ROLLBACK');return send(res,404,{error:'Deposit request not found.'});}if(request.status!=='Pending'){db.exec('ROLLBACK');return send(res,409,{error:'This deposit has already been reviewed.'});}db.prepare('UPDATE deposit_requests SET status=?,reviewed=? WHERE id=?').run(status,now(),id);if(status==='Approved')db.prepare('INSERT INTO account_balances(user_id,balance) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET balance=account_balances.balance+excluded.balance').run(request.user_id,request.amount);db.prepare('INSERT INTO activity(user_id,message,amount,created) VALUES(?,?,?,?)').run(request.user_id,`Deposit ${status.toLowerCase()}`,request.amount.toFixed(3)+' ETH',now());db.exec('COMMIT');return send(res,200,{ok:true});}catch(error){db.exec('ROLLBACK');throw error;}
     }
     if(url.pathname==='/api/admin/mints'){
      const id=Number(input.id),status=String(input.status||'Rejected'),txHash=String(input.txHash||'').trim().slice(0,160);if(!['Minted','Rejected'].includes(status))return send(res,400,{error:'Choose Minted or Rejected.'});const request=db.prepare('SELECT m.*,u.username FROM mint_requests m JOIN users u ON u.id=m.user_id WHERE m.id=?').get(id);if(!request)return send(res,404,{error:'Mint request not found.'});if(request.status!=='Pending')return send(res,409,{error:'This mint request has already been reviewed.'});if(status==='Minted'&&txHash.length<8)return send(res,400,{error:'Enter the confirmed blockchain transaction hash.'});db.exec('BEGIN IMMEDIATE');try{let itemId=null;if(status==='Minted'){const result=db.prepare('INSERT INTO items(name,artist,price,category,image,tag,active,owner_id,created) VALUES(?,?,?,?,?,?,1,?,?)').run(request.title,request.username,request.price.toFixed(3),request.category,request.image_url,'MINTED NFT',request.user_id,now());itemId=result.lastInsertRowid;}db.prepare('UPDATE mint_requests SET status=?,tx_hash=?,item_id=?,reviewed=? WHERE id=?').run(status,txHash,itemId,now(),id);db.prepare('INSERT INTO activity(user_id,message,created) VALUES(?,?,?)').run(request.user_id,status==='Minted'?`NFT minted and listed: ${request.title}`:`Mint request rejected: ${request.title}`,now());db.exec('COMMIT');return send(res,200,{ok:true,itemId});}catch(error){db.exec('ROLLBACK');throw error;}
     }
    if(url.pathname==='/api/admin/moderation')return send(res,200,{ok:true});
   }
   return send(res,404,{error:'Unknown API route.'});
  }
  if(req.method==='GET'&&url.pathname==='/api/admin/overview'){
   const s=requireAdmin(req,res);if(!s)return;const users=db.prepare('SELECT id,username,email,role,active,created FROM users ORDER BY id DESC LIMIT 100').all();const items=db.prepare('SELECT id,name,artist,price,category AS cat,image AS img,tag,active,owner_id FROM items ORDER BY id DESC').all();const bids=db.prepare('SELECT b.id,b.amount,b.status,b.created,u.username,i.name AS item FROM bids b JOIN users u ON u.id=b.user_id JOIN items i ON i.id=b.item_id ORDER BY b.id DESC LIMIT 100').all();const sales=db.prepare('SELECT s.id,s.amount,s.status,s.tx_hash AS txHash,s.created,u.username AS buyer,i.name AS item FROM sales s LEFT JOIN users u ON u.id=s.buyer_id JOIN items i ON i.id=s.item_id ORDER BY s.id DESC LIMIT 100').all();const deposits=db.prepare('SELECT d.id,d.amount,d.tx_hash AS txHash,d.status,d.created,u.username,u.email FROM deposit_requests d JOIN users u ON u.id=d.user_id ORDER BY d.id DESC LIMIT 100').all();const mints=db.prepare('SELECT m.id,m.title,m.description,m.image_url AS imageUrl,m.price,m.category,m.status,m.tx_hash AS txHash,m.created,m.collection_name AS collectionName,m.supply,m.royalty,m.sale_type AS saleType,m.wallet_address AS walletAddress,u.username,u.email FROM mint_requests m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 100').all();const metrics={users:db.prepare('SELECT count(*) AS n FROM users').get().n,activeListings:db.prepare('SELECT count(*) AS n FROM items WHERE active=1').get().n,bids:db.prepare('SELECT count(*) AS n FROM bids').get().n,volume:db.prepare('SELECT COALESCE(sum(amount),0) AS n FROM bids').get().n};return send(res,200,{user:userSummary(s),settings:getSettings(),users,items,bids,sales,deposits,mints,metrics,csrf:s.csrf});
  }
  if(req.method==='GET'){
   const requested=url.pathname==='/'?'/index.html':url.pathname;
   if(requested==='/admin-setup.html'){
    const setupEnabled=(process.env.NXY_ADMIN_SETUP_KEY||'').length>=32,adminExists=!!db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1").get();
    if(!setupEnabled||adminExists){res.writeHead(302,{location:'/admin-login.html','cache-control':'no-store'});return res.end();}
   }
   if(requested==='/admin.html'||requested==='/dashboard.html'){const user=sessionFor(req);if(!user){res.writeHead(302,{location:requested==='/admin.html'?'/admin-login.html':'/login.html?next=dashboard.html','cache-control':'no-store'});return res.end();}if(requested==='/admin.html'&&user.role!=='admin'){res.writeHead(302,{location:'/dashboard.html','cache-control':'no-store'});return res.end();}}
   const file=path.resolve(root,'.'+requested);if(!file.startsWith(root+path.sep))return send(res,403,{error:'Forbidden.'});try{const bytes=await readFile(file);res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream','cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','x-frame-options':'DENY','content-security-policy':"default-src 'self' https://images.unsplash.com https://fonts.googleapis.com https://fonts.gstatic.com; img-src 'self' https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});return res.end(bytes);}catch{return send(res,404,{error:'Page not found.'});}
  }
  return send(res,405,{error:'Method not allowed.'});
 }catch(error){console.error(error);if(!res.headersSent)send(res,500,{error:'The server could not complete this request.'});else res.destroy();}
});

const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>console.log(`NXY NEXUS listening on port ${port}. Persistent database: ${path.join(dataDir,'nxy.sqlite')}`));
