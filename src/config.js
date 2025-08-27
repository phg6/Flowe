/* globals ENV, VERSION */
var Config = {
  version: VERSION,
  websiteUrl: 'https://www.philip.lol',
  functionsUrl: 'https://app.philip.lol',
  helpUrl: 'https://help.briskine.com/',
  dashboardTarget: 'gt-dashboard',

  eventDestroy: 'briskine-destroy',
  eventStatus: 'briskine-status',
  eventSandboxCompile: 'briskine-template-compile',
  eventShowDialog: 'briskine-dialog',
  eventInsertTemplate: 'briskine-insert-template',
}

// firebase staging
if (ENV === 'staging') {
  Config = Object.assign(Config, {
  functionsUrl: 'https://staging.app.philip.lol'
  })
}

if (ENV === 'production') {
  Config = Object.assign(Config, {
  websiteUrl: 'https://www.philip.lol',
  functionsUrl: 'https://app.philip.lol'
  })
}

export default Config
