import { P2pkhWalletPage } from "./P2pkhWalletPage.js";

export function P2pkhMainnetPage() {
  return <P2pkhWalletPage network="main" />;
}

export function P2pkhTestnetPage() {
  return <P2pkhWalletPage network="test" />;
}
