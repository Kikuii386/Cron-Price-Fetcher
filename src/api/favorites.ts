import { IncomingMessage, ServerResponse } from "http";
import { pool } from "../shared/storage.js";

// Helper ส่ง JSON แบบเดียวกับ auth.ts
const json = (res: ServerResponse, status: number, body: any, extraHeaders: Record<string, string> = {}) => {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*", // อย่าลืมเรื่อง CORS ถ้าหน้าบ้านคนละโดเมน
        ...extraHeaders
    });
    res.end(JSON.stringify(body));
};

export async function handleFavorites(req: IncomingMessage, res: ServerResponse) {
    try {
        const url = new URL(req.url || "/", `http://${req.headers.host}`);

        // --- 1. กรณี GET: ดึงรายการโปรดทั้งหมด ---
        if (req.method === "GET") {
            const email = url.searchParams.get("email")?.toLowerCase().trim();

            if (!email) {
                return json(res, 400, { error: "Missing email" });
            }

            // Query หาเหรียญทั้งหมดที่ user คนนี้เคยกดดาวไว้
            const result = await pool.query(
                'SELECT coin_id FROM "UserFavorite" WHERE email = $1',
                [email]
            );

            // ส่งกลับไปเป็น Array ของชื่อเหรียญ เช่น ["bitcoin", "ethereum"]
            const favorites = result.rows.map(row => row.coin_id);
            return json(res, 200, favorites);
        }

        // --- 2. กรณี POST: กดเพิ่ม/ลบ รายการโปรด ---
        if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => {
                body += chunk;
            });

            req.on("end", async () => {
                try {
                    if (!body) return json(res, 400, { error: "No body" });

                    const data = JSON.parse(body);
                    const email = data.email?.toLowerCase().trim();
                    const coinId = data.coinId;
                    const isFavorite = data.isFavorite; // สถานะก่อนกด (ถ้าเป็น true แปลว่ากดเพื่อจะลบ)

                    if (!email || !coinId) {
                        return json(res, 400, { error: "Missing email or coinId" });
                    }

                    if (isFavorite) {
                        // ลบออก
                        await pool.query(
                            'DELETE FROM "UserFavorite" WHERE email = $1 AND coin_id = $2',
                            [email, coinId]
                        );
                    } else {
                        // เพิ่มเข้าไป (ON CONFLICT DO NOTHING ช่วยป้องกัน error ถ้าเผลอกดซ้ำรัวๆ)
                        await pool.query(
                            'INSERT INTO "UserFavorite" (email, coin_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                            [email, coinId]
                        );
                    }

                    return json(res, 200, { success: true });
                } catch (postError) {
                    console.error("Favorites POST Error:", postError);
                    return json(res, 500, { error: "Internal Server Error" });
                }
            });
            return; // ออกจากฟังก์ชัน ปล่อยให้ event listener ทำงานต่อ
        }

        // ถ้าไม่ใช่ GET หรือ POST
        return json(res, 405, { error: "Method not allowed" });

    } catch (e) {
        console.error("Favorites Handler Error:", e);
        return json(res, 500, { error: "Internal Server Error" });
    }
}