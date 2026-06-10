// Debug events.on
import i18next from "i18next";

const inst = i18next.createInstance();
void inst.init({ lng: "en", resources: { en: { common: { greet: "Hi" } } }, ns: ["common"], defaultNS: "common" });
console.log("typeof on:", typeof (inst as any).on);
console.log("typeof emit:", typeof (inst as any).emit);
let called = false;
(inst as any).on("languageChanged", () => {
  called = true;
  console.log("languageChanged fired!");
});
void (inst as any).changeLanguage("zh-CN").then(() => {
  console.log("after changeLanguage, called:", called);
});
