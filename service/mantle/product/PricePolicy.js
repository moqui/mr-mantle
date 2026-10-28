// Price-row invariants and the shared direction/organization boundary. Disabling artifact authorization never grants a price capability.
const P='mantle.product.',E=P+'ProductPrice',PS=P+'PriceServices.'
const find=(n,p)=>ec.entity.find(n).condition(p||{}).disableAuthz()
const one=(n,p)=>find(n,p).one()
const rows=(n,p)=>Array.from(find(n,p).list())
const map=r=>r.getMap?r.getMap():Object.assign({},r)
const ms=v=>v==null||v===''?null:Number.isFinite(Number(String(v)))?Number(String(v)):Date.parse(String(v))
const call=(n,p)=>{const out=ec.service.sync().name(n).parameters(p||{}).disableAuthz().call()||{};if(ec.message.hasError())throw new Error(ec.message.getErrorsString());return out}
const internal=id=>!!id&&!!one('mantle.party.PartyRole',{partyId:id,roleTypeId:'OrgInternal'})
const has=g=>!!ec.user.userId&&(!ec.user.isInGroup('BOSS_PROJECT_CLIENT')||ec.user.isInGroup('ADMIN'))&&(ec.user.isInGroup(g)||g.startsWith('BOSS_PRODUCTS')&&ec.user.isInGroup('BOSS_PRODUCTS_ADMIN'))
const optional=['productStoreId','vendorPartyId','customerPartyId','pricePurposeEnumId','quantityUomId','termUomId','agreementId','agreementItemSeqId']
const writeFields='productId,productStoreId,vendorPartyId,customerPartyId,priceTypeEnumId,pricePurposeEnumId,fromDate,thruDate,minQuantity,price,priceUomId,termUomId,taxInPrice,taxAmount,taxPercentage,taxAuthorityId,agreementId,agreementItemSeqId,otherPartyItemName,otherPartyItemId,comments,quantityIncrement,quantityIncluded,quantityUomId,preferredOrderEnumId,supplierRatingTypeEnumId,standardLeadTimeDays,canDropShip,changeReason'.split(',')
const pick=(p,keys)=>Object.fromEntries(keys.filter(k=>Object.keys(p).includes(k)).map(k=>[k,p[k]===''?null:p[k]]))
function direction(r){return internal(r.vendorPartyId)?'sales':r.vendorPartyId&&internal(r.customerPartyId)?'purchase':!r.vendorPartyId&&!r.customerPartyId?'public':'invalid'}
function access(r,write=false){
 const scope=call(P+'ProductServices.get#CatalogOwnerScope'),admin=scope.systemAdmin,b=one(P+'Product',{productId:r.productId}),d=direction(r)
 if(!b||(!admin&&!scope.ownerPartyIds.includes(b.ownerPartyId)))throw new Error('Price record is not available')
 const org=d==='sales'?r.vendorPartyId:d==='purchase'?r.customerPartyId:null
 for(const id of [r.vendorPartyId,r.customerPartyId].filter(Boolean)){
  const party=one('mantle.party.Party',{partyId:id})
  if(!party||(party.privateOwnerUserId&&party.privateOwnerUserId!==ec.user.userId)||(!admin&&!scope.ownerPartyIds.includes(party.ownerPartyId)&&!scope.organizationPartyIds.includes(id)))throw new Error('Price counterparty is not available')
 }
 if(r.productStoreId){const store=one(P+'store.ProductStore',{productStoreId:r.productStoreId});if(!store||(!admin&&!scope.ownerPartyIds.includes(store.organizationPartyId)))throw new Error('Price store is not available')}
 if(r.agreementId){const agr=one('mantle.party.agreement.Agreement',{agreementId:r.agreementId});if(!agr||(!admin&&!scope.ownerPartyIds.includes(agr.organizationPartyId)))throw new Error('Price agreement is not available');const other=agr.otherPartyId?one('mantle.party.Party',{partyId:agr.otherPartyId}):null;if(other?.privateOwnerUserId&&other.privateOwnerUserId!==ec.user.userId)throw new Error('Price agreement is not available')}
 if(d==='invalid'||(write&&d==='public'&&!admin))throw new Error('Choose an internal sales vendor, or an external supplier and an internal buying organization')
 if(org&&!admin&&!scope.ownerPartyIds.includes(org))throw new Error('Price organization is not available')
 if(r.priceTypeEnumId==='PptAverage'){
  if(!admin&&(write||!has('BOSS_PRODUCTS_COST_READ')&&!has('BOSS_PRODUCTS_COST_ESTIMATE')&&!has('BOSS_PRODUCTS_COST_APPROVE')))throw new Error('Cost authority is required; maintain valuation costs in their owning application')
 }else{
  const group=d==='purchase'?'BOSS_PRODUCTS_SUPPLIER_PRICE_':'BOSS_PRODUCTS_PRICE_'
  if(!admin&&!(write?has(group+'EDIT'):has(group+'READ')||has(group+'EDIT')))throw new Error(d==='purchase'?'Supplier-price authority is required':'Sales-price authority is required')
 }
 return {direction:d,organizationPartyId:org,product:b,systemAdmin:admin,scope}
}
function lock(r){find('moqui.basic.EnumerationType',{enumTypeId:'ProductPriceType'}).forUpdate(true).one();find(P+'Product',{productId:r.productId}).forUpdate(true).one()}
function validate(r,ignoreIds=[]){
 const a=access(r,true)
 if(a.direction==='public')throw new Error('New or corrected prices require an explicit internal sales vendor')
 const policy=rows(P+'ProductPricingSetting',{organizationPartyId:a.organizationPartyId}).filter(s=>(ms(s.fromDate)??-Infinity)<=ms(r.fromDate)&&(ms(s.thruDate)??Infinity)>ms(r.fromDate)).sort((a,b)=>ms(b.fromDate)-ms(a.fromDate))[0]
 if(!ignoreIds.length&&policy?.allowedPurposeIds&&r.pricePurposeEnumId&&!String(policy.allowedPurposeIds).split(',').includes(r.pricePurposeEnumId))throw new Error('Purpose is not permitted by the dated pricing policy')
 if(one('moqui.basic.Enumeration',{enumId:r.priceTypeEnumId})?.enumTypeId!=='ProductPriceType')throw new Error('Choose a price type')
 if(r.pricePurposeEnumId&&one('moqui.basic.Enumeration',{enumId:r.pricePurposeEnumId})?.enumTypeId!=='ProductPricePurpose')throw new Error('Choose a price purpose')
 if(one('moqui.basic.Uom',{uomId:r.priceUomId})?.uomTypeEnumId!=='UT_CURRENCY_MEASURE')throw new Error('Choose a price currency')
 if(r.price==null||toDecimal(r.price).compare(0)<0)throw new Error('Price must be zero or positive')
 if(toDecimal(r.minQuantity||0).compare(0)<0)throw new Error('Minimum quantity cannot be negative')
 const from=ms(r.fromDate),thru=ms(r.thruDate)
 if(from==null||!Number.isFinite(from)||(thru!=null&&(!Number.isFinite(thru)||thru<=from)))throw new Error('End must follow a valid price start')
 if(r.quantityUomId){
  const u=one('moqui.basic.Uom',{uomId:r.quantityUomId})
  if(!u||u.uomTypeEnumId==='UT_CURRENCY_MEASURE'||/PACK|CASE|BOX/.test(u.uomTypeEnumId||'')||(u.uomTypeEnumId==='UT_OTHER_MEASURE'&&!['OTH_ea','OTH_ct','OTH_pp'].includes(r.quantityUomId)))throw new Error('Use a stock quantity unit; a case or pack offer prices its pack product')
 }
 if(r.termUomId&&!one('moqui.basic.Uom',{uomId:r.termUomId}))throw new Error('Choose a term unit')
 for(const k of ['quantityIncrement','quantityIncluded','standardLeadTimeDays'])if(r[k]!=null&&toDecimal(r[k]).compare(0)<0)throw new Error(k+' cannot be negative')
 for(const k of ['taxInPrice','canDropShip'])if(r[k]!=null&&!['Y','N'].includes(r[k]))throw new Error('Choose Yes or No for '+k)
 if(r.taxInPrice==='Y'&&(!r.taxAuthorityId||!one('mantle.other.tax.TaxAuthority',{taxAuthorityId:r.taxAuthorityId})))throw new Error('Choose the authority for included tax')
 if(r.taxPercentage!=null&&(toDecimal(r.taxPercentage).compare(0)<0||toDecimal(r.taxPercentage).compare(100)>0))throw new Error('Tax percentage must be between zero and 100')
 for(const id of [r.vendorPartyId,r.customerPartyId].filter(Boolean)){
  const party=one('mantle.party.Party',{partyId:id})
  if(!party||(party.privateOwnerUserId&&party.privateOwnerUserId!==ec.user.userId)||(!a.systemAdmin&&!a.scope.ownerPartyIds.includes(party.ownerPartyId)&&!a.scope.organizationPartyIds.includes(id)))throw new Error('Price counterparty is not available')
 }
 if(a.direction==='purchase'&&!one('mantle.party.PartyRole',{partyId:r.vendorPartyId,roleTypeId:'Supplier'}))throw new Error('Choose a supplier in the Supplier role')
 if(r.productStoreId){const store=one(P+'store.ProductStore',{productStoreId:r.productStoreId});if(!store||store.organizationPartyId!==a.organizationPartyId)throw new Error('Store is not in the price organization')}
 if(r.agreementItemSeqId&&!r.agreementId)throw new Error('Choose the agreement for its item')
 if(r.agreementId){const agr=one('mantle.party.agreement.Agreement',{agreementId:r.agreementId});if(!agr||agr.organizationPartyId!==a.organizationPartyId)throw new Error('Agreement is not in the price organization');if(r.agreementItemSeqId&&!one('mantle.party.agreement.AgreementItem',{agreementId:r.agreementId,agreementItemSeqId:r.agreementItemSeqId}))throw new Error('Agreement item is not available')}
 // Null scopes match any value; two intersecting scopes with the same specificity and tier would have equal precedence.
 const level=optional.filter(k=>r[k]!=null).length
 for(const other of rows(E,{productId:r.productId,priceTypeEnumId:r.priceTypeEnumId,priceUomId:r.priceUomId})){
  if(ignoreIds.includes(other.productPriceId)||toDecimal(other.minQuantity||0).compare(r.minQuantity||0)!==0)continue
  if(optional.filter(k=>other[k]!=null).length!==level||optional.some(k=>other[k]!=null&&r[k]!=null&&String(other[k])!==String(r[k])))continue
  if(Math.max(ms(other.fromDate)??-Infinity,from)<Math.min(ms(other.thruDate)??Infinity,thru??Infinity))throw new Error('Another price row overlaps this tier at equal precedence')
 }
 return a
}
function fresh(p){
 const row=p.productPriceId?one(E,{productPriceId:p.productPriceId}):null
 if(row&&p.productId&&row.productId!==p.productId)throw new Error('Price record is not available')
 if(p.productPriceId&&!row)throw new Error('Price record is not available')
 if(row&&p.expectedState&&p.expectedState!==ec.user.singleUseCodeHash(JSON.stringify(map(row))))throw new Error('Price changed; preview again before applying')
 if(row&&p.expectedLastUpdatedStamp&&ms(row.lastUpdatedStamp)!==ms(p.expectedLastUpdatedStamp))throw new Error('Price changed; reload before saving')
 return row
}
function store(p){
 let old=fresh(p),data=Object.assign({},old?map(old):{fromDate:ec.user.nowTimestamp,minQuantity:0,pricePurposeEnumId:'PppPurchase'},pick(p,writeFields))
 if(!data.fromDate)data.fromDate=old?.fromDate||ec.user.nowTimestamp
 access(data,true);lock(data);old=fresh(p)
 if(old){access(old,true);if(['productId',...optional,'priceTypeEnumId','priceUomId'].some(k=>String(old[k]??'')!==String(data[k]??'')))throw new Error('Price scope is fixed; create a separate dated row for another scope');if(find('mantle.order.OrderItem',{productPriceId:old.productPriceId}).count()>0&&writeFields.some(k=>String(old[k]??'')!==String(data[k]??'')))throw new Error('This price is referenced; schedule a successor instead of editing it');if(!String(p.changeReason||'').trim())throw new Error('Give a reason for the correction')}
 validate(data,old?[old.productPriceId]:[])
 if(old)data.productPriceId=old.productPriceId
 const saved=call((old?'update#':'create#')+E,pick(data,['productPriceId',...writeFields]))
 return {productPriceId:old?.productPriceId||saved.productPriceId}
}
function replace(p){
 let old=fresh(p);if(!old)throw new Error('Choose the source price');access(old,true);lock(old);old=fresh(p)
 const at=ms(p.effectiveDate),end=ms(old.thruDate)
 if(!Number.isFinite(at)||at<ms(ec.user.nowTimestamp)||at<=ms(old.fromDate)||(end!=null&&at>=end))throw new Error('Successor must start now or later, within the source interval')
 if(!String(p.changeReason||'').trim())throw new Error('Give a reason for the price change')
 const next=Object.assign(map(old),{productPriceId:null,fromDate:new Date(at).toISOString(),price:p.price,changeReason:p.changeReason})
 validate(next,[old.productPriceId])
 call('update#'+E,{productPriceId:old.productPriceId,thruDate:new Date(at).toISOString(),changeReason:p.changeReason})
 const out=call('create#'+E,pick(next,writeFields))
 return {productPriceId:out.productPriceId,previousProductPriceId:old.productPriceId}
}
function expire(p){let old=fresh(p);if(!old)throw new Error('Choose the price to end');access(old,true);lock(old);old=fresh(p);const at=ms(p.thruDate||ec.user.nowTimestamp);if(!Number.isFinite(at)||at<ms(ec.user.nowTimestamp)||at<=ms(old.fromDate)||(ms(old.thruDate)!=null&&at>ms(old.thruDate)))throw new Error('Choose an end now or later within the price interval');if(!String(p.changeReason||'').trim())throw new Error('Give a reason for ending the price');call('update#'+E,{productPriceId:old.productPriceId,thruDate:new Date(at).toISOString(),changeReason:p.changeReason});return {productPriceId:old.productPriceId}}
function findPrices(p){
 const scope=call(P+'ProductServices.get#CatalogOwnerScope'),b=one(P+'Product',{productId:p.productId})
 if(!b||(!scope.systemAdmin&&!scope.ownerPartyIds.includes(b.ownerPartyId)))throw new Error('Product is not available')
 const canRead=scope.systemAdmin||['BOSS_PRODUCTS_PRICE_READ','BOSS_PRODUCTS_PRICE_EDIT','BOSS_PRODUCTS_SUPPLIER_PRICE_READ','BOSS_PRODUCTS_SUPPLIER_PRICE_EDIT','BOSS_PRODUCTS_COST_READ','BOSS_PRODUCTS_COST_ESTIMATE','BOSS_PRODUCTS_COST_APPROVE'].some(has)
 if(!canRead)throw new Error('Price read authority is required')
 const at=ms(p.asOfDate||ec.user.nowTimestamp),out=[]
 for(const row of rows(E,{productId:p.productId})){
  if(p.productPriceId&&row.productPriceId!==p.productPriceId)continue
  if(!p.includeHistory&&!p.productPriceId&&((ms(row.fromDate)!=null&&ms(row.fromDate)>at)||(ms(row.thruDate)!=null&&ms(row.thruDate)<=at)))continue
  if(p.priceTypeEnumId&&row.priceTypeEnumId!==p.priceTypeEnumId)continue
  try{const a=access(row);if(p.direction&&p.direction!=='all'&&a.direction!==p.direction&&!(p.direction==='sales'&&a.direction==='public'))continue;out.push(map(row))}catch(e){/* Not readable in this owner/direction scope; no values leave the boundary. */}
 }
 return {productPriceList:out,productPrice:p.productPriceId?out[0]||null:null}
}
function execute(op,p){
 if(['store','replace','expire'].includes(op))ec.context.putAll(Object.fromEntries(writeFields.map(field=>[field+'_changeReason',p.changeReason||'New price'])))
 return ({store,replace,expire,access,validate,direction,findPrices})[op](p)
}
;({execute,direction})
