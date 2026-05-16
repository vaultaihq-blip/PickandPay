// ─── Google Cloud Vision OCR ──────────────────────────────────────────────────
// Calls DOCUMENT_TEXT_DETECTION for high-accuracy receipt text extraction.
// Falls back gracefully — callers should handle thrown errors.

const VISION_API_URL =
  "https://vision.googleapis.com/v1/images:annotate";

function getApiKey(): string {
  const key = process.env.EXPO_PUBLIC_GOOGLE_CLOUD_API_KEY;
  if (!key || key === "your_google_cloud_key_here") {
    throw new Error("MISSING_GOOGLE_KEY");
  }
  return key;
}

async function imageToBase64(uri: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.blob();
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = () => reject(new Error("Failed to convert image to base64"));
    reader.readAsDataURL(blob);
  });
}

export interface GoogleVisionResult {
  rawText: string;
  confidence: number;
  wordCount: number;
}

export async function extractTextWithGoogleVision(
  imageUri: string
): Promise<GoogleVisionResult> {
  const apiKey = getApiKey();
  const base64 = await imageToBase64(imageUri);

  console.log("🔍 [google-vision] Calling DOCUMENT_TEXT_DETECTION...");

  const body = {
    requests: [
      {
        image: { content: base64 },
        features: [{ type: "DOCUMENT_TEXT_DETECTION", maxResults: 1 }],
        imageContext: {
          languageHints: ["pt", "en"],
        },
      },
    ],
  };

  const response = await fetch(`${VISION_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Google Vision API error ${response.status}: ${err}`);
  }

  const json = await response.json();
  const result = json?.responses?.[0];

  if (!result) throw new Error("Empty response from Google Vision");

  if (result.error) {
    throw new Error(`Google Vision error: ${result.error.message}`);
  }

  const fullText: string = result.fullTextAnnotation?.text ?? "";
  if (!fullText.trim()) {
    throw new Error("Google Vision returned no text — image may be unreadable");
  }

  // Compute average confidence from word-level annotations
  const words: Array<{ confidence?: number }> =
    result.fullTextAnnotation?.pages
      ?.flatMap((p: any) => p.blocks)
      ?.flatMap((b: any) => b.paragraphs)
      ?.flatMap((p: any) => p.words) ?? [];

  const confidenceSum = words.reduce(
    (s: number, w: any) => s + (w.confidence ?? 1),
    0
  );
  const confidence = words.length > 0 ? confidenceSum / words.length : 1;

  console.log(
    `✅ [google-vision] Extracted ${fullText.length} chars, ${words.length} words, confidence ${(confidence * 100).toFixed(1)}%`
  );

  return { rawText: fullText, confidence, wordCount: words.length };
}
