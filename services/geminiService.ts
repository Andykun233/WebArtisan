// import { GoogleGenAI } from "@google/genai";
// import { DataPoint } from "../types";

// // NOTE: In a real production app, you should proxy this through a backend 
// // to avoid exposing the key if it's not user-supplied. 
// // For this demo, we assume the environment variable or user input mechanism.

// export const analyzeRoast = async (data: DataPoint[]): Promise<string> => {
//   if (!process.env.API_KEY) {
//       return "错误: 缺少 API Key。请确保 process.env.API_KEY 已设置。";
//   }

//   // Downsample data to avoid token limits if the roast is long
//   const sampledData = data.filter((_, index) => index % 10 === 0); 
  
//   const prompt = `
//     你是一位世界级的咖啡烘焙专家（Q Grader）。
//     请分析以下烘焙曲线数据（JSON 格式）。
//     数据包含 Time (秒), BT (豆温), ET (炉温), 和 RoR (温升率)。
    
//     数据:
//     ${JSON.stringify(sampledData)}

//     请提供一份简明的分析报告（请务必使用中文回答）：
//     1. 识别脱水期 (Drying Phase)、梅纳反应期 (Maillard Phase) 和发展时间 (Development Time)。
//     2. 检查是否有 "RoR Crash" (失温) 或 "Flick" (回升) 现象。
//     3. 评估发展率 (Development Ratio)。
//     4. 给出 10 分制的最终评分，并提供 1 条改进建议。
//   `;

//   try {
//     const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
//     const response = await ai.models.generateContent({
//       model: 'gemini-2.5-flash',
//       contents: prompt,
//     });
//     return response.text || "未生成分析结果。";
//   } catch (error) {
//     console.error("Gemini Analysis Error:", error);
//     return "分析失败。请检查网络连接或 API 配额。";
//   }
// };

// Export a dummy function to prevent import errors if it's referenced anywhere
export const analyzeRoast = async (data: any[]): Promise<string> => {
    return "AI 功能已禁用";
};