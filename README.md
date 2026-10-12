# DSH Mobile

Mac'te çalışan DeepSeek Harness'ı (DSH) aynı yerel ağdaki iPhone'dan kontrol etmek için native SwiftUI iOS uygulaması (iOS 17+) ve küçük bir Mac gateway'i. Yeni bağımlılık yok: gateway yalnızca Node stdlib, iOS yalnızca Apple framework'leri.

## Mimari

```
iPhone (SwiftUI)  ──HTTPS/WSS, sertifika pin'li, Bearer token──▶  gateway/server.mjs (Mac, :19390, yalnızca LAN alt ağı)
                                                                   │  loopback HTTP + DSH'nin kendi auth URL'si
                                                                   ▼
                                                   DSH host (127.0.0.1)  ◀── gateway/dsh-plugin (upstream.url yazar)
Mac tarayıcısı ──▶ http://127.0.0.1:19391/  (admin: QR, eşleme onayı, cihaz iptali)
```

- **dsh-plugin/index.js**: DSH içinde çalışır, host'un kimlik doğrulamalı loopback URL'sini `~/.dsh-mobile/upstream.url` dosyasına (0600) yazar, DSH kapanınca siler.
- **server.mjs**: telefonlara tek kapı. `POST /pair`, `GET /me`, `POST /api/<method>` (allowlist), WSS `/api/remote.mux` (allowlist'li stream'ler) ve DSH `$events` akışını (onay / soru istekleri) telefonlara dağıtır. Bonjour `_dshmobile._tcp` (TXT `fp=`).
- **ios/**: Sohbet, Oturumlar, Ajanlar, Ayarlar sekmeleri; QR / yapıştır / Bonjour ile eşleme; otomatik yeniden bağlanma.

## Kurulum

1. DSH profiline eklentiyi ekle, `~/.dsh/profiles/desktop/cordis.patch.yml`:
   ```yaml
   - insert: [{id: dsh-mobile-bridge, name: /MUTLAK/YOL/dsh-mobil/gateway/dsh-plugin/index.js}]
   ```
   DSH'yi yeniden başlat; `~/.dsh-mobile/upstream.url` oluşmalı.
2. Gateway: `cd gateway && npm start` (Node 20+, `openssl` ilk çalıştırmada self-signed sertifika üretir). Ortam değişkenleri: `DSH_MOBILE_IFACE` (varsayılan `en0`), `DSH_MOBILE_PORT` (19390), `DSH_MOBILE_DIR` (`~/.dsh-mobile`).
3. Mac'te `http://127.0.0.1:19391/` aç; QR görünür.
4. iOS: `ios/DSHMobile.xcodeproj` aç, gerçek cihaz için Signing Team seç, çalıştır. QR'ı tara (veya içeriğini yapıştır / Bonjour listesinden seç), Mac'teki admin sayfasında **Onayla**.
5. Proje dosyası `ios/project.yml`'den üretilir: değişiklikten sonra `cd ios && xcodegen generate`.

## Güvenlik değerlendirmesi

- **TLS + pinning**: telefon yalnızca QR'daki SHA-256 parmak izine eşit sertifikayı kabul eder (CA zinciri yok sayılır, başka sertifika = bağlantı kesilir, istek gönderilmeden). MITM testi her iki tarafta var.
- **Eşleme**: QR'daki 128-bit rastgele tek kullanımlık kod, 5 dk geçerli, tekrar kullanılamaz; ayrıca Mac'te elle onay (120 sn). Admin arayüzü yalnızca `127.0.0.1`.
- **Token**: 256-bit rastgele, iOS Keychain'de (`ThisDeviceOnly`); Mac yalnızca SHA-256 hash'ini saklar (`devices.json`, 0600). 30 gün TTL. Karşılaştırma sabit zamanlı.
- **İptal**: admin'den cihaz silinince token geçersizleşir ve o cihazın açık soketleri anında kapanır.
- **Yalnızca LAN**: gateway seçili arayüzün IPv4 alt ağı dışındaki bağlantıları TCP seviyesinde düşürür; ağ değişince yeniden bağlanır ve eski bağlantıları kapatır. iOS tarafı yalnızca özel/link-local IPv4 adreslere bağlanır.
- **Rate limit / brute force**: IP başına 10 sn'de 300 istek; 60 sn'de 10 hatalı auth → IP bloke.
- **RPC allowlist**: yalnızca `server.mjs` içindeki `RPC` / `STREAMS` / `EVENTS` kümeleri geçer; diğerleri 403, hatalı WS frame'i soketi kapatır. Host'un ev dizini gibi bilgiler event akışından düşürülür.
- **Onaylar**: telefon yalnızca "bir kez izin ver" / "reddet" diyebilir; yanıt yoksa veya "Mac'te karar ver" seçilirse karar DSH masaüstüne kalır (ilk yanıt kazanır).
- Telemetri, üçüncü taraf servis, internet çıkışı yok.

## Bilinen sınırlamalar

Kodda `shortcut:` yorumlarıyla işaretli:

- Bağlam penceresi doluluğu gösterilmez (DSH model kataloğunda limit yok); yalnızca token sayıları.
- APNs yok: bildirimler yalnızca iOS soketi canlı tuttuğu sürece (arka plana geçtikten sonra birkaç saniye) gelir.
- Oturum listesi yalnızca ilk sayfa; transcript yalnızca snapshot penceresi (eski geçmiş sayfalanmaz).
- Yanıtlanmayan telefon istekleri 10 dk sonra DSH masaüstüne düşer (sabit süre).
- Rate limit sayaçları bellekte; tek ev ağı için yeterli.
- `Localizable.strings` yalnızca bağlantı durum anahtarlarını kapsar; arayüz metinleri İngilizce.

## Desteklenmeyenler

İnternet / uzaktan erişim (relay, VPN), çoklu Mac, dosya gezgini / terminal, eski geçmişi sayfalama, arka plan push bildirimleri, ses girişi, iPad'e özel düzen.

## Testler

- Gateway: `cd gateway && npm test` → **12/12 geçti** (subnet, eşleme + hash'li saklama, yetkisiz erişim, kod tekrarı/süre/ret, MITM, allowlist, iptal + replay, LAN-only, ağ değişimi, event yönlendirme, eşzamanlılık, brute force).
- iOS: `cd ios && xcodebuild -project DSHMobile.xcodeproj -scheme DSHMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test CODE_SIGNING_ALLOWED=NO` → **6/6 geçti** (kendi sertifikası kabul, MITM reddi, LAN-only, QR doğrulama, Markdown blokları, içerik/soru ayrıştırma). Uygulama iOS Simulator için derleniyor (Xcode 26.6).
- Gerçek cihaz: iPhone 13 için imzalı derleme (`-destination 'platform=iOS,name=iPhone' -allowProvisioningUpdates`), `xcrun devicectl device install app` ile kurulum ve açılış **başarılı**.
- Canlı DSH uçtan uca (`gateway/e2e.mjs`, elle çalıştırılır) → **14/14 geçti**, gerçek DSH 0.2.0-rc.2 ve gerçek LAN adresi (192.168.1.44) üzerinde: yanlış pin reddi, eşleme + onay, kod tekrarı reddi, upstream bağlantısı, session/list·create·rename, goals/get, agentPresets/list, session/modelCatalog, allowlist dışı yöntem 403, WSS session/follow snapshot, iptal sonrası 401. Ayrıca `dns-sd -L` ile Bonjour yayını (fp TXT kaydıyla) ve `lsof` ile yalnızca `192.168.1.44:19390` + `127.0.0.1:19391` dinlendiği doğrulandı.

Kendi `~/.dsh` profiline dokunmadan canlı test için DSH'yi geçici bir profil ve eklentiyi ekleyen bir patch dosyasıyla açın:

```sh
DSH_HOME=/tmp/dshe2e/home DSH_MOBILE_DIR=/tmp/dshe2e/mobile ELECTRON_RUN_AS_NODE=1 +  "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" +  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" +  web --patch /tmp/dshe2e/patch.yml --no-open --port 0
cd gateway && DSH_MOBILE_DIR=/tmp/dshe2e/mobile node server.mjs   # ayrı terminal
cd gateway && node e2e.mjs                                         # üçüncü terminal
```

`patch.yml`, Kurulum bölümündeki eklenti kaydının aynısıdır. Geçici profilde model hesabı olmadığından prompt gönderme bu testte denenmez.

