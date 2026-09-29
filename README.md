# MS YAYIN

TikTok LIVE yayın yönetim paneli.

## Sistem
- TikTok kullanıcı adı ile bağlanma
- Server-side browser observer (Puppeteer + Chromium)
- Puanlama (1-10, süre ayarlı)
- Racon Kralları
- Mekan Sahibi
- Beğeni Sıralaması
- WIN Sayacı
- Test Merkezi
- OBS / TikTok Live Studio overlay linkleri

## Render
Build Command:
`npm install`

Start Command:
`npm start`

## Önemli
TikTok'un web canlı yayın yapısı zaman zaman değişebilir veya otomatik tarayıcı trafiğini engelleyebilir. Bu proje, tiktok-live-connector yerine Chromium üzerinden herkese açık canlı yayın sayfasındaki ağ olaylarını gözlemlemeyi dener. TikTok tarafından bloklanırsa panel yine Test Merkezi ve overlay'lerle çalışır; canlı veri için sunucu logunda hata görünür.
