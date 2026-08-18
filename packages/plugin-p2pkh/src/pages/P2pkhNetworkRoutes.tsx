import { P2pkhWalletPage } from "./P2pkhWalletPage.js";

export function P2pkhMainnetTransactionsPage() {
  return <P2pkhWalletPage network="main" view="transactions" />;
}

export function P2pkhTestnetTransactionsPage() {
  return <P2pkhWalletPage network="test" view="transactions" />;
}

export function P2pkhMainnetLocalTransactionsPage() {
  return <P2pkhWalletPage network="main" view="local-transactions" />;
}

export function P2pkhTestnetLocalTransactionsPage() {
  return <P2pkhWalletPage network="test" view="local-transactions" />;
}
