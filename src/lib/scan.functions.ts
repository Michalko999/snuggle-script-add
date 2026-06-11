import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export const CATEGORIES = [
  "Ovocie a zelenina",
  "Mliečne výrobky",
  "Mäso a ryby",
  "Pečivo",
  "Cestoviny, ryža, múka",
  "Konzervy a omáčky",
  "Sladkosti a snacky",
  "Nápoje",
  "Mrazené",
  "Drogéria a domácnosť",
  "Iné",
] as const;

export type Category = (typeof CATEGORIES)[number];

const ItemSchema = z.object({
  text: z.string(),
  category: z.enum(CATEGORIES),
});

export const scanList = createServerFn({ method: "POST" })
  .inputValidator(
    z.object({
      mimeType: z.string().min(1),
      base64Data: z.string().min(1),
    }),
  )
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) {
      throw new Error("LOVABLE_API_KEY nie je nastavený.");
    }

    const prompt = `Prečítaj tento nákupný/úloh zoznam (rukou písaný alebo tlačený, slovenský alebo anglický) a vráť len položky. Pre každú urči kategóriu z tohto zoznamu: ${CATEGORIES.join(", ")}. Ak si nie si istý, použi "Iné". Vráť len validné JSON pole bez markdown.`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: { url: `data:${data.mimeType};base64,${data.base64Data}` },
              },
            ],
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "submit_items",
              description: "Odovzdaj rozpoznané položky zoznamu s kategóriami.",
              parameters: {
                type: "object",
                properties: {
                  items: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        text: { type: "string" },
                        category: { type: "string", enum: [...CATEGORIES] },
                      },
                      required: ["text", "category"],
                      additionalProperties: false,
                    },
                  },
                },
                required: ["items"],
                additionalProperties: false,
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "submit_items" } },
      }),
    });

    if (response.status === 429) {
      throw new Error("Príliš veľa požiadaviek. Skús neskôr.");
    }
    if (response.status === 402) {
      throw new Error("Vyčerpaný kredit na AI Gateway. Pridaj kredit v nastaveniach.");
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`AI Gateway chyba: ${response.status} ${errText}`);
    }

    const payload = await response.json();
    const toolCall = payload?.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall?.function?.arguments) {
      return { items: [] as Array<z.infer<typeof ItemSchema>> };
    }

    let parsed: { items?: unknown } = {};
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch {
      return { items: [] };
    }

    const items = z.array(ItemSchema).safeParse(parsed.items ?? []);
    return { items: items.success ? items.data : [] };
  });

export const categorizeText = createServerFn({ method: "POST" })
  .inputValidator(z.object({ text: z.string().min(1).max(200) }))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) return { category: "Iné" as Category };

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `Zaraď položku nákupného zoznamu do JEDNEJ z týchto kategórií: ${CATEGORIES.join(", ")}. Odpovedz LEN názvom kategórie, nič iné.`,
          },
          { role: "user", content: data.text },
        ],
      }),
    });

    if (!response.ok) return { category: "Iné" as Category };
    const payload = await response.json();
    const raw = (payload?.choices?.[0]?.message?.content ?? "").trim();
    const match = CATEGORIES.find((c) => raw.toLowerCase().includes(c.toLowerCase()));
    return { category: (match ?? "Iné") as Category };
  });
