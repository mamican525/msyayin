# MS YAYIN

MS Yayın, TikTok canlı yayını için Room tabanlı yönetim paneli ve overlay sistemi.

## Render

Build Command:
`npm install`

Start Command:
`npm start`

Node: 18+

## Yapı

- `/` yeni yayın odası oluşturur.
- `/panel?room=MS-XXXXXX` yönetim panelidir.
- `/overlay?room=MS-XXXXXX&type=puanlama` overlay açar.
- `/api/*` JSON API'sidir.

## Özellikler

- Otomatik Room kodu
- Değiştirilebilir puanlama süresi
- 1-10 puan yorumları
- Racon Kralları hediye tetikleyicileri
- Mekan Sahibi hediye tetikleyicileri
- Beğeni sıralaması
- WIN sayacı
- Test Merkezi
- OBS / TikTok Live Studio overlay linkleri
- TikTok bağlantısı için uyumlu Connector yükleme katmanı
