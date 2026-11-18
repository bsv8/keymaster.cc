import { APP_MARKET_SYNC_CAPABILITY, type PluginManifest, type PluginSetup } from "@keymaster/contracts";
const definition={id:"apps",name:"Market",description:"仅同步市场来源；主数据和审批归 Connect Worker。",units:[
 {id:"apps.window",runtime:"window-main",scopeKind:"root",provides:[],dependencies:[]},
 {id:"apps.coordinator-worker",runtime:"shared-worker",scopeKind:"root",provides:[APP_MARKET_SYNC_CAPABILITY],dependencies:[]},
],setup() {}} satisfies PluginManifest & {setup:PluginSetup};
const {setup:marketSetup,...marketPlugin}=definition;
export {marketPlugin,marketSetup};
