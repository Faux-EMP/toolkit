export function setup(ctx) {
 const action = ctx.ui.registerInputBarAction({
  id: "toggle-vault-mode",
  label: "Toggle Vault Recall (Strict / All Vaults)",
  enabled: true
 });

 action.onClick(() => {
  ctx.sendToBackend({ type: "TOGGLE_VAULT_MODE" });
 });
}