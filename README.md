# LabelCheck

**Front vs back.** The front of a pack says "lite", "natural", "no added sugar". The back – the ingredients list, the E-numbers, the nutrition table – often tells a different story.

LabelCheck is a free web app for the supermarket aisle:

1. Take a photo of the **front** and the **back** of a product.
2. **Add** more products you're choosing between (up to 9), and optionally one photo of the whole **shelf**.
3. Tap **Compare**. LabelCheck sends the photos and a carefully written question to the AI app you already have (Gemini, ChatGPT, Copilot, Claude…).
4. The AI checks every front claim against the back, decodes hidden sugars and E-numbers, ranks the products for *your* health profile, and suggests better options on the shelf or in the store you're in.
5. Tell LabelCheck what you bought. It remembers, and next time your history goes along with the question, so the advice gets more personal.

## Principles

- **Free, forever.** No ads, no subscriptions, nothing to sell.
- **No server, no accounts, no tracking.** Your health profile and history live only on your phone (IndexedDB). Photos go only to the AI app *you* choose.
- **Use what's already there.** No AI of our own – the phone's assistant does the thinking.
- **Information only, not medical advice.**

## Technical

Plain HTML/CSS/JavaScript, no build step. Installable as a PWA. Hosted on GitHub Pages.

- Each product's front and back are stitched into one labelled image (P1, P2, …) so up to 9 products + 1 shelf photo fit in Gemini's 10-image limit.
- Sharing uses the Web Share API (files + text); the question is also copied to the clipboard in case the AI app ignores shared text.
- Optional store lookup uses the device location once against OpenStreetMap's Overpass API.

## Licence

MIT
