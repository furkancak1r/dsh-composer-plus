# Tether

DeepSeek Harness için resmi olmayan uzaktan kumanda; DeepSeek ile bağlantısı yoktur.

Tether, [dsh-composer-plus](../README.md) eklentisinin bir parçasıdır. Mac tarafı ayrı bir eklenti değildir: dsh-composer-plus kuruluyken **Ayarlar → Composer Plus → Mobile connect (iPhone)** anahtarını açın. Anahtar varsayılan olarak kapalıdır, çünkü bu Mac'te bir ağ portu açar.

Mac'te çalışan DeepSeek Harness'ı (DSH) aynı yerel ağdaki ya da Tailscale ile bağlı iPhone'dan kontrol etmek için native SwiftUI iOS uygulaması (iOS 17+) ve küçük bir Mac gateway'i. Yeni bağımlılık yok: gateway yalnızca Node stdlib, iOS yalnızca Apple framework'leri.

## Mimari

```
iPhone (SwiftUI)  ──HTTPS/WSS, sertifika pin'li, Bearer token──▶  gateway/server.mjs (Mac, :19390, yalnızca LAN alt ağı ve tailnet)
                                                                   │  loopback HTTP + DSH'nin kendi auth URL'si
                                                                   ▼
                                                   DSH host (127.0.0.1)  ◀── dsh-composer-plus Host yarısı (index.js) gateway'i çalıştırır
Mac tarayıcısı ──▶ http://127.0.0.1:19391/  (admin: QR, eşleme onayı, cihaz iptali)
```

- **dsh-composer-plus (`../index.js`)**: Mobile connect açıkken gateway'i DSH'nin kendi sürecinde çalıştırır. DSH'nin kimlik doğrulamalı loopback URL'sini gateway'e bellekten verir (diske token yazılmaz). Anahtar kapanınca, eklenti kaldırılınca veya DSH kapanınca gateway durur.
- **server.mjs**: telefonlara tek kapı. `POST /pair`, `GET /me`, `POST /api/<method>` (allowlist), WSS `/api/remote.mux` (allowlist'li stream'ler) ve DSH `$events` akışını (onay / soru istekleri) telefonlara dağıtır. Bonjour `_dshmobile._tcp` (TXT `fp=`).
- **ios/**: Sohbet, Oturumlar, Ajanlar, Ayarlar sekmeleri; QR / yapıştır / Bonjour ile eşleme; otomatik yeniden bağlanma; sınırsız sayıda Mac.

## Composer Plus özellikleri

Composer Plus'ın her özelliğinin Tether'deki yeri [FEATURES.md](FEATURES.md) dosyasındadır. Eklentiye yeni bir özellik eklenince bu tabloya da satır eklenmelidir; yoksa `npm test` hata verir (`test/tether-parity.test.mjs`).

Son eklenenler:

- **Mark all as read**: Oturumlar'da proje başlığının yanındaki **…** düğmesine dokunun. Projenin bütün yeşil noktaları telefonda ve Mac'in okunmamış listesinde gider. Aynı menüde **Copy path** da vardır.
- **Copy message link**: bir mesajı basılı tutun. Bağlantı sohbeti ve mesajı gösterir. Mesajınızdaki bağlantının altında **Open message** düğmesi çıkar. Dokununca o sohbet açılır ve mesaj 2 sn işaretlenir.
- **Kuyruktaki mesajı düzenleme**: kuyruk satırının menüsü → **Edit**. Mesaj kuyruktaki yerini korur.
- **Redo**: geri almadan sonra yazı alanının üstünde **Redo** çıkar. Geri alınan tur yeni bir sohbette geri gelir; istenirse dosyalar da geri gelir. Eski sohbet olduğu gibi kalır.
- **Changes → Mode → This chat** ve **Hide whitespace**: sohbetin dosya araçlarının yazdığı dosyalar ve yalnız boşluk değişikliklerini gizleme. **Mode** menüsünde beş görünüm vardır. **Hide whitespace** satırının yazısına dokunmak da anahtarı değiştirir.

## Mac'i beklerken

Tether, Mac'ten yanıt beklediği her an bunu gösterir. Bekleme hata gibi ya da donmuş bir ekran gibi görünmez.

- **Açılış**: Mac'e bağlanırken **Connecting to your Mac…** ve dönen halka görünür. **Can't reach your Mac** ve **Retry** yalnız bağlantı gerçekten kurulamazsa çıkar (yaklaşık 10 sn sonra).
- **Arka plandan dönüş**: çalışan bir bağlantı koptuysa Tether sessizce yeniden bağlanır ve **Connecting…** gösterir. Çevrimdışı ekranı çıkmaz.
- **Mesaj gönderme**: mesaj hemen sohbette, soluk renkte ve altında **Sending…** ile görünür. Mac'teki kopyası gelince normal mesaja döner. Gönderme başarısız olursa mesaj kalkar ve yazı alanına geri gelir.
- **Sohbet açma**: sohbetin mesajları gelene kadar **Loading the chat…** görünür.
- **Diğer işlemler** (yeni sohbet, sabitleme, arşivleme, ad değiştirme, silme, hedef, kuyruk, durdurma, model ya da izin seçimi, onaylar ve sorular): yanıt 0,4 sn'den uzun sürerse ekranın üstünde **Waiting for your Mac…** görünür. Ekran bu sırada kullanılabilir kalır.
- Başka bir Wi‑Fi'dan bağlanırken her istek önce Mac'in ev adresini deniyor ve 5 sn bekliyordu. Artık son yanıt veren adres (örneğin Tailscale) önce denenir.

## Sohbet ekranı: düşünme ve araç adımları

Sohbet, DSH masaüstündeki gibi kısa görünür. Ayrıntılar akordiyon gibi kapalıdır; dokununca açılır.

- Düşünme ve araç çağrıları tek satıra toplanır. Satırda işin türü yazar, örneğin "Read files and searched code". En çok yapılan üç tür yazılır.
- Çalışan adım ne yaptığını gösterir, örneğin "Running commands · npm test". Yanında dönen halka vardır.
- Biten tur "Completed in 1m 5s" satırına katlanır. Altında yalnız son cevap görünür. Satıra dokununca turun bütün adımları açılır.
- Hata veren ya da durdurulan tur ("Failed", "Stopped") katlanmaz.
- Bir sohbeti açınca bütün biten turlar kapalı başlar.

## Oturum listesindeki işaretler

İşaretler DSH masaüstündeki kenar çubuğuyla aynıdır:

- Gri, dönen halka: sohbet çalışıyor. Sohbetin bir alt ajanı çalışırken de halka görünür.
- Yeşil nokta: sohbet bitti ve siz henüz açmadınız. Sohbeti Mac'te ya da iPhone'da açınca nokta gider. Liste yenilenmeden de güncellenir.
- Turuncu el: sohbet sizden onay ya da yanıt bekliyor.

Sistemde "azaltılmış hareket" açıksa halka dönmez.

## Kurulum

1. DSH'ye dsh-composer-plus eklentisini kur: Ayarlar → Eklentiler → **Eklenti ekle** → `dsh-composer-plus`.
2. **Ayarlar → Composer Plus → Mobile connect (iPhone)** anahtarını aç. Gateway hemen başlar ve DSH yeniden açıldığında da başlar. `openssl` ilk açılışta self-signed sertifika üretir. Veriler `$DSH_HOME/storages/dsh-composer-plus/mobile/` klasöründedir (cihazlar, sertifika, QR). Ortam değişkenleri: `DSH_MOBILE_IFACE` (varsayılan `en0`), `DSH_MOBILE_PORT` (19390), `DSH_MOBILE_ADMIN_PORT` (19391), `DSH_MOBILE_DIR`.
3. DSH'de sol alttaki **Mobile connect** düğmesine bas ya da Mac'te `http://127.0.0.1:19391/` adresini aç. QR, cihazlar ve Tailscale durumu görünür.
4. iOS: `ios/DSHMobile.xcodeproj` aç, gerçek cihaz için Signing Team seç, çalıştır. Xcode'da Apple hesabı yoksa uygulama, Mac'teki kayıtlı geliştirici sertifikasıyla elle imzalanır ve `xcrun devicectl device install app` ile kurulur. Adımlar [AGENTS.md](AGENTS.md) dosyasının "Signing for the iPhone" bölümündedir.
5. QR kodunu iPhone **Kamera** uygulamasıyla okut ve **Tether'de Aç**'a dokun, ya da Tether'de **Scan code**'a dokun. Telefonda **Connect**'e, Mac'te **Approve**'a bas. Kamera yalnız Tether kuruluysa çalışır: QR bir `tether://pair?…` bağlantısıdır. Bağlantı tek başına eşleştirmez: Tether önce sorar.
6. Proje dosyası `ios/project.yml`'den üretilir: değişiklikten sonra `cd ios && xcodegen generate`.

Eski `dsh-mobile-bridge` eklentisini kullandıysan, `cordis.patch.yml` içindeki kaydını sil. Eski `~/.dsh-mobile` klasörü artık okunmaz: telefonu yeni QR koduyla bir kez daha eşleştir.

## Eşleşme adımları

- Telefon: kod okundu → Mac'e bağlanılıyor → "Mac'te Approve'a basın" (geri sayım, **Cancel**) → bağlandı (titreşim) ya da nedenini söyleyen hata ve **Try again**.
- Mac sayfası: bekleyen istek QR'ın yerine geçer (iPhone adı, IP, kalan süre, **Approve** / **Deny**). İstek biterse sayfa nedenini 60 sn gösterir: bağlandı, reddedildi, iPhone vazgeçti, süre doldu. Biten isteğe **Approve** → 409 ve açık bir cümle.
- Eşleşme isteği kendi sabitlenmiş URLSession'ını kullanır. Eskiden başka bir (ya da eski sertifikalı) Mac'in yeniden bağlanma döngüsü ortak oturumu yeniliyor ve bekleyen isteği iptal ediyordu: Mac'teki Approve kartı kayboluyordu.
- Aynı adres ve aynı Mac adıyla (ya da adsız eski kayıtla) yeni bir sertifika eşleşince eski kayıt silinir; kullanıcının verdiği ad yenisine geçer.

## Birden fazla Mac

Telefon istediğiniz kadar Mac'e eşleşebilir. Sınır yoktur.

1. Her Mac'te dsh-composer-plus kurulu olsun ve **Mobile connect** açık olsun.
2. Tether'de sol üstteki Mac adına dokunun, **Add a Mac…** seçin. O Mac'in QR kodunu tarayın, **Connect**'e dokunun ve Mac'te **Approve**'a basın.
3. Sol üstteki Mac adından Mac'ler arasında geçin. Ayarlar → **Macs** bölümünde bir Mac'i yeniden adlandırabilir (yalnız bu iPhone'da) ya da eşleşmesini kaldırabilirsiniz.

### Mac'e kendi adınızı verin (takma ad)

Uygulama her yerde (sol üstteki Mac adı, Ayarlar, eşleşme ekranı) Mac'in bilgisayar adı yerine sizin verdiğiniz adı gösterir.

1. Eşleşme bitince Tether **Name this Mac** kutusunu açar. Kutuda Mac'in kendi adı yazılıdır. İstediğiniz adı yazıp **Save**'e dokunun. Adı değiştirmek istemiyorsanız **Cancel**'a dokunun.
2. Adı sonra değiştirmek için sol üstteki Mac adını basılı tutun, ya da Ayarlar → **Macs** → satırdaki kaleme dokunun. Mac adına kısa dokunmak, Mac'ler arasında geçiş menüsünü açar.
3. Kutuyu boş bırakıp kaydederseniz Mac'in kendi adı geri gelir.

- Ad yalnız bu iPhone'da saklanır. Mac'e ve başka telefonlara gitmez.
- Ayarlar'da sizin adınızın altında Mac'in kendi adı ve adresi görünür.
- Mac yeni sertifika yaparsa ve yeniden eşleşirseniz sizin adınız korunur. Eşleşme ekranı da bu adı gösterir.

- Her Mac kendi sertifika parmak izini, token'ını ve adreslerini (LAN, Tailscale) ayrı saklar. Bir Mac'in token'ı başka bir Mac'e hiç gönderilmez.
- Aynı anda yalnız ekrandaki Mac'e bağlanılır. Geçişte eski Mac'in bağlantısı kapanır, ekran temizlenir ve yeni Mac'e bağlanılır. Geç gelen eski yanıtlar yok sayılır.
- Okunmamış noktaları, son görülen liste ve taslaklar Mac'e göre ayrı tutulur.
- Gateway, Mac'in adını (`scutil --get ComputerName`) QR koduna, `/pair` ve `/me` yanıtlarına ve Bonjour ilanına ekler. Eski bir gateway ad göndermezse telefon Mac'in adresini gösterir.
- Eski sürümle eşleşmiş iPhone'un eşleşmesi ilk açılışta listeye taşınır; yeniden eşleşme gerekmez.
- Sınır: ekrandaki Mac dışındaki Mac'lerden onay ve soru bildirimi gelmez. Onları görmek için o Mac'e geçin.

## Uzaktan erişim (Tailscale)

1. Mac'e ve iPhone'a [Tailscale](https://tailscale.com/download) kur, ikisinde de aynı hesapla giriş yap.
2. Mobile connect anahtarını kapatıp aç ya da DSH'yi yeniden başlat. Admin sayfası "Away from home: Tailscale is on (100.x.y.z)." satırında Tailscale adresini gösterir.
3. Önceden eşleşmiş telefonun bir kez evde (aynı Wi‑Fi'de) bağlanması yeterli, Tailscale adresini kendisi öğrenir. Yeni QR da olur.
4. Bitti: Wi‑Fi dışındayken uygulama Tailscale üzerinden bağlanır, Ayarlar'da "Route" hangi yolun kullanıldığını gösterir.

### Tailscale kestirmesi (Shortcut)

Tether, iPhone'da Tailscale'i açmak için **Tether Tailscale** adlı bir kestirme kullanır. iOS, uygulamaların kullanıcının kestirmelerini görmesine izin vermez. Bu yüzden Tether, kestirmenin eklendiğini bilemez. Kestirmeyi Tether'den bir kez çalıştırmak gerekir:

1. Ayarlar → **Tailscale** → **Add the Tailscale shortcut** ile kestirmeyi ekleyin. Kestirmenin adı tam olarak `Tether Tailscale` olmalı.
2. **Check the shortcut**'a dokunun. Kestirmeler uygulaması kestirmeyi çalıştırır ve Tether'e geri döner.
3. Satır **Ready** gösterir. Bundan sonra "Run the shortcut when the Mac is unreachable" anahtarı açılabilir.

- Kestirme çalışmazsa satır **Didn't run** gösterir. Altında Kestirmeler uygulamasının verdiği neden yazar, örneğin kestirme bulunamadı.
- Satırda **Not checked yet** yazıyorsa kestirme henüz Tether'den çalıştırılmamıştır. Kestirmenin eksik olduğu anlamına gelmez.

Gateway asla public internete açılmaz: yalnızca yerel ağdan ve tailnet'ten (100.64.0.0/10, fd7a:115c:a1e0::/48) gelen bağlantıları kabul eder, gerisi TLS kurulmadan kesilir. Sertifika sabitleme ve token aynen geçerli.

## Güvenlik değerlendirmesi

- **TLS + pinning**: telefon yalnızca QR'daki SHA-256 parmak izine eşit sertifikayı kabul eder (CA zinciri yok sayılır, başka sertifika = bağlantı kesilir, istek gönderilmeden). MITM testi her iki tarafta var.
- **Eşleme**: QR'daki 128-bit rastgele tek kullanımlık kod, 5 dk geçerli, tekrar kullanılamaz; ayrıca Mac'te elle onay (120 sn). Admin arayüzü yalnızca `127.0.0.1`.
- **Token**: 256-bit rastgele, iOS Keychain'de (`ThisDeviceOnly`); Mac yalnızca SHA-256 hash'ini saklar (`devices.json`, 0600). 30 gün TTL. Karşılaştırma sabit zamanlı.
- **Eşlenmiş iPhone'lar ve iptal**: Mobile connect panelindeki **Paired iPhones** listesi her iPhone'u adı, eşleşme tarihi ve son bağlantı zamanıyla gösterir. **Remove** tek tıkla (onay sorusu olmadan) o cihazın token'ını siler; açık soketleri anında kapanır ve cihaz yeniden eşleşmeden bağlanamaz. Son bağlantı zamanı bellekte hemen, `devices.json` dosyasında en çok dakikada bir güncellenir.
- **Tailscale only**: paneldeki bu seçenek açıkken gateway yerel ağdan (Wi‑Fi, kablo) gelen her bağlantıyı TCP seviyesinde reddeder, açık LAN bağlantılarını da hemen kapatır; yalnızca tailnet adreslerinden gelen bağlantıyı kabul eder. Bonjour ilanı da durur: Mac'in adı, portu ve sertifika parmak izi yerel ağa duyurulmaz, Mac Tether'in "Macs on this Wi‑Fi" listesinde görünmez (eşlenmiş telefon tailnet adresiyle bağlanır). Ayar `settings.json` dosyasında saklanır (0600) ve yeniden başlatmada korunur. Paylaşılan Wi‑Fi (kafe, ofis) için.
- **Erişim günlüğü**: gateway her bağlantı denemesini zaman, IP adresi, cihaz adı ve sonuçla (kabul ya da ret, nedeniyle: ağ dışı, Tailscale only, TLS, hatalı ya da silinmiş anahtar, hatalı eşleşme kodu, hız sınırı, eşleşme reddi/zaman aşımı/iptal) kaydeder. Aynı deneme bir dakika içinde tekrarlanırsa tek satırın sayacı artar. En yeni 200 kayıt `access.json` dosyasında (0600) tutulur; panel en yeni 50 kaydı ve son 24 saatteki ret sayısını gösterir. Günlükte token ya da eşleşme kodu yoktur.
- **Uygulama kilidi**: Tether **Settings → Privacy → Lock with Face ID** açıkken uygulama açılırken ve arka plandan dönerken Face ID, Touch ID ya da cihaz parolası ister. Kilit ekranı ayrı bir pencerede durur; açık bir onay sayfasını ve klavyeyi de örter. Face ID penceresinde Vazgeç'e basmak yeni bir istek açmaz: **Unlock** düğmesi yeniden ister. Cihazda parola yoksa kilit kendini kapatır (kullanıcı dışarıda kalmaz). Kilit, iOS kilit ekranındaki bildirim önizlemelerini gizlemez.
- **Yalnızca LAN ve tailnet**: gateway, seçili arayüzün IPv4 alt ağı ve tailnet dışındaki bağlantıları TCP seviyesinde düşürür; ağ değişince yeniden bağlanır ve eski bağlantıları kapatır. iOS tarafı yalnızca özel/link-local IPv4 adreslere ve Tailscale adreslerine (100.64.0.0/10, `*.ts.net`) bağlanır.
- **Rate limit / brute force**: IP başına 10 sn'de 300 istek; 60 sn'de 10 hatalı auth → IP bloke.
- **RPC allowlist**: yalnızca `server.mjs` içindeki `RPC` / `STREAMS` / `EVENTS` kümeleri geçer; diğerleri 403, hatalı WS frame'i soketi kapatır. Host'un ev dizini gibi bilgiler event akışından düşürülür.
- **Onaylar**: telefon yalnızca "bir kez izin ver" / "reddet" diyebilir; yanıt yoksa veya "Mac'te karar ver" seçilirse karar DSH masaüstüne kalır (ilk yanıt kazanır).
- Telemetri, üçüncü taraf servis, internet çıkışı yok.

## Bilinen sınırlamalar

Kodda `shortcut:` yorumlarıyla işaretli:

- Bağlam penceresi doluluğu gösterilmez (DSH model kataloğunda limit yok); yalnızca token sayıları.
- APNs yok: bildirimler yalnızca iOS soketi canlı tuttuğu sürece (arka plana geçtikten sonra birkaç saniye) gelir.
- Sohbet önce yalnız son mesajları gösterir. Daha eski mesajlar için sohbetin başındaki **Load earlier messages** düğmesine dokunun.
- Yanıtlanmayan telefon istekleri 10 dk sonra DSH masaüstüne düşer (sabit süre).
- Rate limit sayaçları bellekte; tek ev ağı için yeterli.
- `Localizable.strings` yalnızca bağlantı durum anahtarlarını kapsar; arayüz metinleri İngilizce.
- **Tailscale only** açıkken de Mac'in bir Wi‑Fi/Ethernet IPv4 adresi olmalı (gateway yalnızca onunla başlar). Mac'te Tailscale kapalıysa hiçbir iPhone bağlanamaz; panel bunu uyarır.
- Erişim günlüğü yalnız en yeni 200 denemeyi tutar; çok sayıda farklı IP'den gelen deneme eski kayıtları siler.

## Desteklenmeyenler

Tailscale dışında internet üzerinden erişim (relay, açık port), aynı anda birden fazla Mac'e bağlı kalma, dosya gezgini / terminal, arka plan push bildirimleri, ses girişi, iPad'e özel düzen.

## Ajanla iPhone testi (agent-device)

Uygulamayı iPhone'da veya iOS simülatöründe açan, kullanan ya da kontrol eden ajanlar [agent-device](https://github.com/callstack/agent-device) kullanır. Derleme, kurulum ve kullanım adımları ile kurallar [AGENTS.md](AGENTS.md) dosyasındadır.

Bir kez kurun (Node.js 22.12 veya üstü gerekir):

```sh
npm install -g agent-device@latest
agent-device doctor
```

Gerçek iPhone için:

- iPhone eşleşmiş ve güvenilir olmalı, Geliştirici Modu açık olmalı.
- agent-device, iPhone'a kendi runner uygulamasını kurar. Bu uygulamayı imzalamak için `AGENT_DEVICE_IOS_TEAM_ID` ve `AGENT_DEVICE_IOS_BUNDLE_ID` değişkenlerini ayarlayın. Değerler AGENTS.md dosyasındadır.

## Testler

- Gateway: depo kökünde `npm test` (`test/tether-gateway.test.mjs`: subnet, tailnet, eşleme + hash'li saklama, yetkisiz erişim, kod tekrarı/süre/ret, MITM, allowlist, iptal + replay, LAN-only, ağ değişimi, event yönlendirme, eşzamanlılık, brute force, token yenileme) ve `test/mobile-connect.test.mjs` (anahtar, gateway yaşam döngüsü, Ayarlar satırı, kenar çubuğu düğmesi).
- Gerçek DSH ile eklenti içinden uçtan uca: `PLAYWRIGHT=/path/to/playwright node test/browser-mobile-connect.mjs /path/to/dsh/lib/bin.js` (varsayılan kapalı, anahtarı açma, QR'lı açılır pencere, sahte iPhone eşleme + `session/list`, allowlist 403, kapatınca portların kapanması). Mac'in Wi-Fi adresi gerekir.
- iOS: `cd ios && xcodebuild -project DSHMobile.xcodeproj -scheme DSHMobile -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test CODE_SIGNING_ALLOWED=NO` → **48/48 geçti** (Xcode 27.1, 27.10.2026). Dört paket: `CoreTests` (sertifika pin'i ve MITM reddi, LAN ve tailnet adresleri, QR ve eşleşme bağlantısı, Markdown, birden fazla Mac, yeni sohbet isteği, dallanan (fork) sohbet, eski geçmişi yükleme, Composer Plus kuralları, mesaj bağlantısı, okunmamış noktalar, Redo, Changes sorgusu), `UserTextTests` (mesajdaki bağlantı), `BranchTreeTests` (dal ağacı) ve `AppLockTests` (Face ID kilidi). Simülatör yoksa paket Mac Catalyst hedefiyle (`-target arm64-apple-ios17.0-macabi`) derlenip çalıştırılabilir.
- Gerçek cihaz (iPhone 13, iOS 27.2, 27.10.2026): imzasız derleme, kayıtlı sertifikayla elle imza ([AGENTS.md](AGENTS.md), "Signing for the iPhone"), `xcrun devicectl device install app` ile kurulum **başarılı**; eşleşmeler korunur. agent-device ile telefonda dokunma testi için Mac'te `DevToolsSecurity` açık olmalıdır.
- Canlı DSH uçtan uca (`test/tether-e2e.mjs`, elle çalıştırılır; birleşmeden önceki sonuç) → **14/14 geçti**, gerçek DSH 0.2.0-rc.2 ve gerçek LAN adresi (192.168.1.44) üzerinde: yanlış pin reddi, eşleme + onay, kod tekrarı reddi, upstream bağlantısı, session/list·create·rename, goals/get, agentPresets/list, session/modelCatalog, allowlist dışı yöntem 403, WSS session/follow snapshot, iptal sonrası 401. Ayrıca `dns-sd -L` ile Bonjour yayını (fp TXT kaydıyla) ve `lsof` ile yalnızca `192.168.1.44:19390` + `127.0.0.1:19391` dinlendiği doğrulandı.

`test/tether-e2e.mjs`, Mobile connect anahtarı açık ve model hesabı olan bir DSH'ye bağlanır, gerçek bir model turu da dener. Kendi profilin yerine geçici bir `DSH_HOME` kullan.

