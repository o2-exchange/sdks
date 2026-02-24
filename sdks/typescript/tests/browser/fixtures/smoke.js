const status = document.getElementById("status");

try {
  const sdk = await import("/dist/index.js");
  const wallet = sdk.O2Client.generateWallet();
  const client = new sdk.O2Client({ network: sdk.Network.TESTNET });
  client.close();

  if (typeof wallet?.b256Address !== "string" || !wallet.b256Address.startsWith("0x")) {
    throw new Error("wallet generation failed");
  }

  status.textContent = "ok";
  status.dataset.status = "ok";
} catch (error) {
  status.textContent = String(error);
  status.dataset.status = "error";
}
