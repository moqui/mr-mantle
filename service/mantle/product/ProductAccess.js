// Application-independent domain permissions. Disabling artifact authz does not bypass these checks.
function systemAdmin(){return !!ec.user.userId&&ec.user.isInGroup('ADMIN')}
function has(permission){return !!ec.user.userId&&(systemAdmin()||!ec.user.hasPermission('PROJECT_CLIENT')&&(permission!=='ADMIN'&&ec.user.hasPermission(permission)))}
;({systemAdmin,has})
