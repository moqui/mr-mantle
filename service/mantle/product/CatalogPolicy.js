// Catalog permissions and actual owner membership are independent of an application's launcher.
const method=()=>ec.resource.script('component://mr-mantle/service/mantle/product/MethodPolicy.js'),permissions=()=>ec.resource.script('component://mr-mantle/service/mantle/product/ProductAccess.js')
const find=(n,p={})=>method().find(n,p),one=(n,p)=>method().one(n,p),rows=(n,p={})=>method().rows(n,p),call=(n,p={})=>method().call(n,p),map=r=>method().map(r),ms=v=>method().ms(v),iso=v=>method().iso(v),active=(r,d)=>method().active(r,d),pick=(p,f)=>method().pick(p,f),fingerprint=v=>method().fingerprint(v)
function scope(p={},need='read'){
 const access=permissions(),admin=access.has('PRODUCT_CATALOG_ADMIN'),edit=admin||access.has('PRODUCT_CATALOG_EDIT'),read=edit||access.has('PRODUCT_CATALOG_VIEW');if(!({read,edit,admin})[need])throw new Error('Catalog '+need+' authority is required')
 const s=call('mantle.product.ProductServices.get#CatalogOwnerScope'),organizationPartyId=p.organizationPartyId||s.activeOrganizationPartyId||s.organizationPartyIds[0]||null
 if(organizationPartyId&&(!s.systemAdmin&&!s.ownerPartyIds.includes(organizationPartyId)||!one('mantle.party.PartyRole',{partyId:organizationPartyId,roleTypeId:'OrgInternal'})))throw new Error('Catalog organization is not available')
 return Object.assign({},s,{read,edit,admin,organizationPartyId})
}
function product(id,s,write=false){const r=one('mantle.product.Product',{productId:id});if(!r||!s.systemAdmin&&!s.ownerPartyIds.includes(r.ownerPartyId||'_NA_'))throw new Error('Catalog product is not available');if(write&&(!r.ownerPartyId||r.ownerPartyId==='_NA_')&&!s.systemAdmin)throw new Error('Shared catalog changes require system administration');return r}
function organization(p,need='admin'){const s=scope(p,need);if(!s.organizationPartyId)throw new Error('Choose an internal organization');return s}
const reason=p=>method().reason(p),audit=(f,r)=>method().audit(f,r),convert=(q,a,b,d)=>method().convert(q,a,b,d),unit=id=>method().unit(id)
;({scope,product,organization,find,one,rows,call,map,ms,iso,active,pick,fingerprint,reason,audit,convert,unit})
