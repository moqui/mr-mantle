// Read-only, reusable resolved list output. Each independent price resolves in its own transaction.
const P='mantle.product.',S=P+'PriceServices.'
const policy=()=>ec.resource.script('component://mr-mantle/service/mantle/product/PriceLists.js')
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
function report(p){
 const list=policy().getList(p.priceListId),scope=policy().guard(list),asOfDate=p.asOfDate||ec.user.nowTimestamp,quantity=toDecimal(p.quantity??1)
 if(!Number.isFinite(policy().ms(asOfDate))||quantity.compare(0)<=0)throw new Error('Choose a valid as-of date and positive quantity')
 if(list.state!=='published'||!policy().at(list,asOfDate))throw new Error('Choose a published price list effective on the report date')
 const ids=(Array.isArray(p.productIds)?p.productIds:[p.productIds]).flatMap(v=>String(v||'').split(/[\s,]+/)).filter(Boolean)
 if(ids.length>1000)throw new Error('Choose at most 1000 products for one price-list output')
 let query=ec.entity.find(P+'Product').disableAuthz();if(!scope.systemAdmin)query=query.condition('ownerPartyId','in',scope.ownerPartyIds);if(ids.length)query=query.condition('productId','in',ids)
 const products=Array.from(query.orderBy('productId').limit(1001).list());if(products.length>1000)throw new Error('Filter the output to at most 1000 products')
 const params={organizationPartyId:list.organizationPartyId,direction:list.direction,priceListId:list.priceListId,priceUomId:list.priceUomId,pricePurposeEnumId:list.pricePurposeEnumId,productStoreId:list.productStoreId,agreementId:list.agreementId,agreementItemSeqId:list.agreementItemSeqId,partyClassificationId:list.partyClassificationId,geoId:list.geoId,validDate:asOfDate,quantity}
 for(const role of policy().parties(list.priceListId,asOfDate))params[role.roleTypeId==='Vendor'?'vendorPartyId':'customerPartyId']=role.partyId
 for(const key of ['vendorPartyId','customerPartyId'])if(p[key]){if(params[key]&&params[key]!==p[key])throw new Error('The report counterparty must match the list scope');params[key]=p[key]}
 if(list.direction==='sales'){if(p.vendorPartyId&&p.vendorPartyId!==list.organizationPartyId)throw new Error('The internal pricing party must match the list scope');params.vendorPartyId=list.organizationPartyId}else{if(p.customerPartyId&&p.customerPartyId!==list.organizationPartyId)throw new Error('The internal pricing party must match the list scope');params.customerPartyId=list.organizationPartyId}
 for(const key of ['vendorPartyId','customerPartyId'])if(params[key])policy().party(params[key],scope)
 if(list.direction==='purchase'&&(!params.vendorPartyId||!ec.entity.find('mantle.party.PartyRole').condition({partyId:params.vendorPartyId,roleTypeId:'Supplier'}).disableAuthz().one()))throw new Error('Choose a supplier for the purchase report')
 const priceRows=[]
 for(const product of products){
  const row={productId:product.productId,productName:product.productName,quantity:String(quantity),quantityUomId:p.quantityUomId||product.amountUomId||'OTH_ea',priceUomId:list.priceUomId,price:null,priceAvailable:false,priceListId:null,priceRuleId:null,status:'Unavailable'}
  ec.message.pushErrors()
  try{
   const result=ec.service.sync().name(S+'get#ProductPrice').parameters(Object.assign({},params,{productId:product.productId,quantityUomId:row.quantityUomId})).disableAuthz().requireNewTransaction(true).call()||{}
   if(ec.message.hasError())throw new Error(ec.message.getErrorsString())
   if(result.priceAvailable){Object.assign(row,{price:result.price,priceAvailable:true,priceListId:result.priceListId,priceRuleId:result.priceRuleId,productPriceId:result.productPriceId,status:'Available'})}
  }catch(e){ec.logger.error('Effective price list '+list.priceListId+' product '+product.productId+' failed: '+e);row.status='Price could not be resolved'}
  finally{ec.message.clearErrors();ec.message.popErrors()}
  priceRows.push(row)
 }
 const reportContext={priceListId:list.priceListId,listName:list.listName,organizationPartyId:list.organizationPartyId,direction:list.direction,priceUomId:list.priceUomId,asOfDate:new Date(policy().ms(asOfDate)).toISOString(),quantity:String(quantity),quantityUomId:p.quantityUomId||null,vendorPartyId:params.vendorPartyId||null,customerPartyId:params.customerPartyId||null,productCount:priceRows.length}
 const columns=['productId','productName','quantity','quantityUomId','price','priceUomId','status'],labels={priceListId:'List',listName:'Name',organizationPartyId:'Organization',direction:'Direction',priceUomId:'Currency',asOfDate:'As of',quantity:'Quantity',quantityUomId:'Quantity unit',vendorPartyId:'Vendor',customerPartyId:'Customer',productCount:'Products'},head=Object.entries(reportContext).filter(([,v])=>v!=null).map(([k,v])=>'<dt>'+esc(labels[k])+'</dt><dd>'+esc(v)+'</dd>').join('')
 const printHtml='<!doctype html><html><head><meta charset="utf-8"><style>body{font:12px Arial;margin:24px}table{border-collapse:collapse;width:100%}th,td{padding:6px;text-align:left;border-bottom:1px solid #ddd}thead{display:table-header-group}dt{font-weight:bold;float:left;clear:left;width:160px}dd{margin-left:170px}@page{size:A4 landscape;margin:14mm}</style></head><body><h1>Effective price list — '+esc(list.listName)+'</h1><dl>'+head+'</dl><table><thead><tr>'+['Product','Name','Quantity','Unit','Price','Currency','Result'].map(v=>'<th>'+esc(v)+'</th>').join('')+'</tr></thead><tbody>'+priceRows.map(r=>'<tr>'+columns.map(k=>'<td>'+esc(r[k])+'</td>').join('')+'</tr>').join('')+'</tbody></table></body></html>'
 return{reportContext,effectivePriceRows:priceRows,printHtml}
}
;({report})
