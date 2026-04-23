# Gece Köyü 🧛

Vampir-Köylü dijital oyun yöneticisi.

## Yerel Çalıştırma

```bash
npm install
npm start
# → http://localhost:3000
```

## Deploy (Railway - Ücretsiz)

1. [railway.app](https://railway.app) → New Project → Deploy from GitHub
2. Bu klasörü GitHub'a yükle
3. Environment variable: `PORT=3000` (otomatik set edilir)
4. Verilen URL'i herkese paylaş

## Deploy (Render - Ücretsiz)

1. [render.com](https://render.com) → New Web Service
2. Build Command: `npm install`
3. Start Command: `npm start`

## Oynanış

### GM
1. "Oyun Kur" → oda kodu üretilir
2. Oyuncular katılır
3. Rolleri ve süreleri ayarla
4. "Oyunu Başlat"

### Oyuncular
1. "Odaya Katıl" → oda kodunu gir
2. Rolünü gör (sadece sen görürsün)
3. Gece: aksiyonunu yap (vampir, doktor, dedektif, vb.)
4. Gündüz: tartışırken oy ver
5. Oylama → son savunma → asılsın mı?

## Roller
- 🧛 Vampir — öldür
- 💉 Doktor — koru
- 🔍 Dedektif — sorgula
- 🏹 Avcı — ölünce birini götürür
- 🧙 Cadı — öldür veya dirilt (1 kez)
- 🃏 Joker — linç edilince kazanır
- 👁️ Kahin — iki kişiyi karşılaştır
- 🛡️ Koruyucu — koru (kendini koruyamaz)
- 👨‍🌾 Köylü — köyü koru
