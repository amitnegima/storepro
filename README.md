# 🏬 StorePro — Your Store, Online in 5 Minutes

**Website:** [storepro.in](https://www.storepro.in)

StorePro is a zero-infrastructure SaaS platform that lets any small business go online instantly using Google Sheets as the database.

## Features

- **4 Store Templates:** Fast Food, Restaurant, Dhaba, Grocery
- **Google Sheets Backend:** No server needed — reads/writes via Sheets API
- **Shopkeeper Dashboard:** Real-time order management with notifications
- **WhatsApp Integration:** Order notifications + customer messaging
- **UPI Payments:** QR code + GPay/PhonePe/Paytm deep links
- **Order Tracking:** Customers track orders in real-time
- **PWA Support:** Install as app on mobile
- **Multi-tenant:** One codebase serves unlimited stores

## Architecture

```
Customer → storepro.in/fastfood.html?store=slug
                    ↓
           Google Sheets (JSONP read)
           Google Apps Script (write orders)
                    ↓
Shopkeeper → storepro.in/dashboard.html?store=slug
```

## File Structure

```
├── index.html          # Landing page + smart router
├── fastfood.html       # Fast food store template
├── restaurant.html     # Restaurant template
├── dhaba.html          # Dhaba template
├── store.html          # Grocery store template
├── dashboard.html      # Shopkeeper dashboard
├── admin.html          # SaaS admin panel
├── manifest.json       # PWA manifest
├── sw.js               # Service worker
├── icon-192.png        # PWA icon
├── icon-512.png        # PWA icon
├── scripts/
│   ├── store-apps-script.js      # Per-store Apps Script
│   └── registry-apps-script.js   # Master registry Apps Script
├── templates/
│   ├── shri-balaji-config.csv    # Example store config
│   ├── shri-balaji-menu.csv      # Example menu (49 items)
│   └── *-template.csv            # Blank templates
└── docs/
    ├── STOREPRO_VS_SHOPIFY.md    # Why StorePro
    └── READINESS_AUDIT.md        # Launch checklist
```

## Deployment

Hosted on **Vercel** as static files. No build step needed.

```bash
# Push to GitHub → auto-deploys to Vercel
git add .
git commit -m "StorePro v1.0"
git push origin main
```

## Config Keys

Each store has a Google Sheet with a Config tab. Key settings:

| Key | Example | Purpose |
|-----|---------|---------|
| ShopName | Shri Balaji Fast Food | Store name |
| Phone | 919711402685 | Primary phone |
| Phone2 | 919711784614 | Secondary phone |
| WhatsApp | 919711402685 | WhatsApp number |
| Address | Shop No. 4, Surat Nagar... | Store address |
| VegOnly | Yes | Pure veg restaurant |
| HeroTitle2 | !! Jai Shri Balaji Maharaj !! | Blessing text |
| DeliveryFee | 0 | Delivery charge |
| PackingFee | 0 | Packing charge |
| DashboardPIN | 1234 | Dashboard access PIN |
| OrderScript | https://script.google.com/... | Apps Script URL |

## Built by Amit Negi

📱 WhatsApp: [9760684971](https://wa.me/919760684971)
