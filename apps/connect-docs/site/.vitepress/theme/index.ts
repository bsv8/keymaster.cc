import DefaultTheme from "vitepress/theme";
import ConnectHome from "./ConnectHome.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("ConnectHome", ConnectHome);
  }
};
