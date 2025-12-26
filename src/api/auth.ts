import { IncomingMessage, ServerResponse } from "http";
import { pool } from "../shared/storage.js";

// Helper เล็กๆ สำหรับส่ง JSON (ก๊อปมาเพื่อให้ไฟล์นี้ทำงานได้ด้วยตัวเอง)
const json = (res: ServerResponse, status: number, body: any) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

export function handleAuthCheck(req: IncomingMessage, res: ServerResponse) {
  let body = "";

  // 1. รับข้อมูลที่ส่งมา
  req.on("data", (chunk) => {
    body += chunk;
  });

  // 2. เมื่อรับครบแล้ว ให้เช็ค DB
  req.on("end", async () => {
    try {
      if (!body) return json(res, 400, { error: "No body" });
      
      const data = JSON.parse(body);
      const email = data.email?.toLowerCase().trim();

      if (!email) {
        return json(res, 400, { error: "Missing email" });
      }

      // Query Database
      const result = await pool.query(
        'SELECT id FROM "AllowedUser" WHERE email = $1 LIMIT 1',
        [email]
      );

      // ส่งผลลัพธ์กลับ
      return json(res, 200, { isAllowed: result.rows.length > 0 });
    } catch (e) {
      console.error("Auth Error:", e);
      return json(res, 500, { error: "Internal Server Error" });
    }
  });
}