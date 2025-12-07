import { GoogleGenAI } from "@google/genai";
import { DataPoint } from "../types";

// NOTE: In a real production app, you should proxy this through a backend 
// to avoid exposing the key if it's not user-supplied. 
// For this demo, we assume the environment variable or user input mechanism.

export const analyzeRoast = async (data: DataPoint[]): Promise<string> => {
  if (!process.env.API_KEY) {
      return "Error: API Key is missing. Please ensure process.env.API_KEY is set.";
  }

  // Downsample data to avoid token limits if the roast is long
  const sampledData = data.filter((_, index) => index % 10 === 0); 
  
  const prompt = `
    You are a world-class coffee roasting expert (Q Grader).
    Analyze the following roast profile data (JSON format).
    The data contains Time (seconds), BT (Bean Temp Celsius), ET (Environment Temp), and RoR (Rate of Rise).
    
    Data:
    ${JSON.stringify(sampledData)}

    Please provide a concise analysis:
    1. Identify the Drying Phase, Maillard Phase, and Development Time if possible.
    2. Check for "RoR Crash" or "Flick".
    3. Evaluate the development ratio.
    4. Give a final score out of 10 and 1 suggestion for improvement.
  `;

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "No analysis generated.";
  } catch (error) {
    console.error("Gemini Analysis Error:", error);
    return "Failed to analyze roast profile. Please check your connection and API limits.";
  }
};
