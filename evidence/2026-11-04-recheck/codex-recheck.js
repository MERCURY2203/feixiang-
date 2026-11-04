// Independent follow-up audit; no external services. Successful assertions reproduce remaining defects.
process.env.MCH_ID='1900000000'; process.env.PAY_MODE='';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const F=require('./fake-cloud');const {store,wechat,clock,call}=F;
const booking=F.loadFn('booking'),admin=F.loadFn('admin'),timer=F.loadFn('timer');
const cloud=require('wx-server-sdk'),ord=require('../cloudfunctions/booking/lib/orders');
const BASE=Date.UTC(2026,10,10,2),DAY=86400000,results=[];
const doc=(c,id)=>store.read(c,id).doc;
function seed(){store.reset();wechat.reset();clock.now=BASE;store.write('users','U',{openid:'wxU',role:'customer',phone:'13800001111',nickname:'User',phoneBoundAt:BASE});store.write('users','O',{openid:'wxO',role:'owner'});store.write('products','P',{name:'Coupon',price:5000,stock:10,soldCount:0,onShelf:true,images:['cloud://P'],fixedDate:false,sort:0,createdAt:0});}
function must(r){assert.ok(r.ok,JSON.stringify(r));return r.data;}
async function checkout(items=[{type:'product',productId:'P',qty:1}]){return must(await call(booking,'wxU',{action:'checkout',items})).orderId;}
async function buy(){const id=await checkout();wechat.pay(id);await ord.confirmIfPaid(cloud,F.db,doc('orders',id));return id;}
const item=id=>store.all('order_items').find(i=>i.orderId===id);
async function test(name,fn){seed();const detail=await fn();results.push({name,detail});console.log('REPRODUCED',name,JSON.stringify(detail));}
(async()=>{
await test('N1 late failed retry overwrites successful refund and double-counts ledger',async()=>{
 const id=await buy(),it=item(id);const reserved=await ord.reserveRefund(F.db,{orderId:id,parts:[{itemId:it._id,qty:0,amount:1000}],by:'admin'});
 const original=cloud.cloudPay.refund;let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);let calls=0;
 cloud.cloudPay.refund=async p=>{calls++;if(calls===1){enter();await gate;throw Error('delayed network failure');}return original(p)};
 try{const first=ord.processRefund(cloud,F.db,reserved.outRefundNo);await entered;await ord.processRefund(cloud,F.db,reserved.outRefundNo);assert.equal(doc('refunds',reserved.outRefundNo).status,'success');release();await first;assert.equal(doc('refunds',reserved.outRefundNo).status,'unknown');await ord.processRefund(cloud,F.db,reserved.outRefundNo);assert.equal(doc('orders',id).refundedFee,2000);assert.equal(wechat.refundedTotal(id),1000);return {actualRefund:1000,orderLedger:2000,itemLedger:doc('order_items',it._id).refundedFee};}finally{cloud.cloudPay.refund=original}
});
await test('N2 partial amount refund consumes sole coupon and prevents refunding remaining balance',async()=>{
 const id=await buy(),it=item(id);must(await call(admin,'wxO',{action:'refund',orderId:id,parts:[{itemId:it._id,qty:1,amount:1000}]}));
 const after=doc('orders',id);assert.equal(after.status,'refunded');const again=await call(admin,'wxO',{action:'refund',orderId:id,parts:[{itemId:it._id,qty:0,amount:4000}]});assert.equal(again.ok,false);return {paid:after.totalFee,refunded:after.refundedFee,status:after.status,remaining:ord.itemRefundable(doc('order_items',it._id)),retry:again.message};
});
await test('N3 repeated identical stock adjustment is applied twice',async()=>{
 const product={_id:'P',name:'Updated',price:5000,stock:15,stockFrom:10,images:['cloud://P'],onShelf:true,fixedDate:false};
 must(await call(admin,'wxO',{action:'productSave',product}));must(await call(admin,'wxO',{action:'productSave',product}));assert.equal(doc('products','P').stock,20);return {before:10,requestedStock:15,afterRetry:20};
});
await test('N4 legacy pending order without itemIds is cancelled without releasing holds',async()=>{
 const id=await checkout([{type:'court',date:'2026-11-11',court:1,hour:10},{type:'product',productId:'P',qty:1}]);const o=doc('orders',id);delete o.itemIds;store.write('orders',id,o);
 must(await call(booking,'wxU',{action:'cancel',orderId:id}));assert.equal(doc('orders',id).status,'cancelled');assert.ok(doc('slot_locks','2026-11-11_1_10'));assert.equal(doc('products','P').stock,9);return {status:'cancelled',courtStillLocked:true,stock:9,expectedStock:10};
});
await test('N5 legacy active order without itemIds is shown as fully refunded',async()=>{
 const id=await buy(),o=doc('orders',id);delete o.itemIds;store.write('orders',id,o);const response=must(await call(booking,'wxU',{action:'orderDetail',orderId:id}));assert.equal(response.order.status,'refunded');return {status:response.order.status,refundedFee:doc('orders',id).refundedFee,actualRefund:wechat.refundedTotal(id)};
});
await test('N6 legacy verification log without userId retains phone after purge',async()=>{
 store.write('verify_logs','OLD',{type:'verify',orderId:'OLD_ORDER',itemId:'OLD_ITEM',phone:'13800001111',day:'2026-11-10',at:BASE});store.write('orders','OLD_ORDER',{userId:'U',phone:'13800001111',status:'completed',createdAt:BASE});clock.now=Date.UTC(2027,10,12,19);await call(timer,'',{});assert.equal(doc('users','U').phone,'');assert.equal(doc('verify_logs','OLD').phone,'13800001111');return {userPhone:doc('users','U').phone,legacyLogPhone:doc('verify_logs','OLD').phone};
});
await test('N7 newly issued coupon can reuse a legacy active code',async()=>{
 store.write('orders','OLD',{userId:'oldUser',status:'active',totalFee:5000,itemIds:['OLD_ITEM']});store.write('order_items','OLD_ITEM',{kind:'product',userId:'oldUser',orderId:'OLD',productId:'P',qty:1,price:5000,code:'111111',codeActive:true});
 const original=Math.random;Math.random=()=>0.15;let id;try{id=await buy()}finally{Math.random=original}const it=item(id);assert.equal(it.code,'111111');const lookup=must(await call(admin,'wxO',{action:'verifyLookup',code:'111111'}));assert.equal(lookup.itemId,it._id);return {oldItem:'OLD_ITEM',newItem:it._id,duplicateCode:it.code,lookupItem:lookup.itemId};
});
fs.writeFileSync(path.resolve(__dirname,'../../recheck-results.json'),JSON.stringify(results,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
