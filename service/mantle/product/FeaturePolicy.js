// Feature-pair domain rules. Application services check owner and grant before calling these private operations.
const entity='mantle.product.feature.ProductFeatureIactn'
const rows=(name,p)=>Array.from(ec.entity.find(name).condition(p||{}).list())
const one=(name,p)=>ec.entity.find(name).condition(p||{}).one()
const key=row=>row.productFeatureId+' → '+row.toProductFeatureId
function validateRules(rules) {
    const dependencies={}
    for(const row of rules) if(row.iactnTypeEnumId==='PfitDependency') (dependencies[row.productFeatureId] ||= []).push(row.toProductFeatureId)
    const reaches=(a,b,seen=new Set())=>{
        if(a===b) return true
        if(seen.has(a)) return false
        seen.add(a)
        return (dependencies[a]||[]).some(next=>reaches(next,b,seen))
    }
    for(const row of rules) if(row.iactnTypeEnumId==='PfitIncompatible' && (reaches(row.productFeatureId,row.toProductFeatureId) || reaches(row.toProductFeatureId,row.productFeatureId)))
        throw new Error('Feature dependency conflicts with incompatible rule '+key(row))
}
function store(p) {
    if(p.productFeatureId===p.toProductFeatureId) throw new Error('A feature cannot interact with itself')
    for(const id of [p.productFeatureId,p.toProductFeatureId]) if(!one('mantle.product.feature.ProductFeature',{productFeatureId:id})) throw new Error('Feature is not available')
    if(!['PfitDependency','PfitCompatible','PfitIncompatible','PfitComposition'].includes(p.iactnTypeEnumId)) throw new Error('Choose a feature interaction type')
    if(p.productId && !one('mantle.product.Product',{productId:p.productId})) throw new Error('Product is not available')
    if(p.quantity!=null && toDecimal(p.quantity).compare(0)<=0) throw new Error('Interaction quantity must be positive')
    ec.entity.find('moqui.basic.EnumerationType').condition({enumTypeId:'ProductFeatureIactnType'}).forUpdate(true).one()
    const all=rows(entity), old=all.find(row=>row.productFeatureId===p.productFeatureId && row.toProductFeatureId===p.toProductFeatureId)
    if(old && (old.productId||null)!==(p.productId||null)) throw new Error('Feature pair '+key(old)+' already has a rule in another product scope')
    const reverse=all.find(row=>row.productFeatureId===p.toProductFeatureId && row.toProductFeatureId===p.productFeatureId)
    if(reverse && (reverse.productId||null)!==(p.productId||null)) throw new Error('Feature pair '+key(reverse)+' already has a rule in another product scope')
    if(reverse&&!old)throw new Error('Feature pair '+key(reverse)+' already has a rule in the reverse direction')
    const data={productFeatureId:p.productFeatureId,toProductFeatureId:p.toProductFeatureId,iactnTypeEnumId:p.iactnTypeEnumId,productId:p.productId||null,quantity:p.quantity,amount:p.amount}
    const candidate=all.filter(row=>row!==old).concat([data])
    const scopes=new Set([null,...candidate.map(row=>row.productId||null)])
    for(const scope of scopes) validateRules(candidate.filter(row=>!row.productId || row.productId===scope))
    ec.service.sync().name('store#'+entity).parameters(data).call()
    return data
}
function preview(p) {
    const selected=new Set(Array.isArray(p.productFeatureIds)?p.productFeatureIds:String(p.productFeatureIds||'').split(',').filter(Boolean))
    const issues=[], compositions=[]
    for(const row of rows(entity).filter(row=>!row.productId || row.productId===p.productId)) {
        const a=selected.has(row.productFeatureId),b=selected.has(row.toProductFeatureId)
        if(row.iactnTypeEnumId==='PfitDependency' && a && !b) issues.push({rule:key(row),productFeatureId:row.productFeatureId,toProductFeatureId:row.toProductFeatureId,message:'Required feature '+row.toProductFeatureId+' is missing'})
        if(row.iactnTypeEnumId==='PfitIncompatible' && a && b) issues.push({rule:key(row),productFeatureId:row.productFeatureId,toProductFeatureId:row.toProductFeatureId,message:'Features are incompatible'})
        if(row.iactnTypeEnumId==='PfitComposition' && a && b) compositions.push({rule:key(row),quantity:row.quantity,amount:row.amount})
    }
    return {valid:issues.length===0,issues,compositions}
}
function execute(op,p) {
    const was=ec.artifactExecution.disableAuthz()
    try {return ({store,preview})[op](p)} finally {if(!was) ec.artifactExecution.enableAuthz()}
}
;({execute})
