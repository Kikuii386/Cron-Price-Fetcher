import { fetchCoingeckoPriceById, fetchCoingeckoBatchByIds } from "../src/vendors/coingecko.js";

async function main() {
  // ลองเหรียญเดียว
  const price = await fetchCoingeckoPriceById("conan-2");
  console.log("BTC =", price);

  // ลอง batch หลายเหรียญ
  const result = await fetchCoingeckoBatchByIds(["riku", "airtor-protocol", "basedai"]);
  console.log(result);
}

main().catch(console.error);