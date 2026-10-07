// Demo content (Indonesian, fictional). No real brands, no real people or addresses: names are
// common Indonesian given/family names, streets are `Jl. Contoh …` (area labels are the fake
// shipping provider's fixtures), phones are in the 0812-0000-xxxx test range, e-mails end in
// `@demo.bukalaris.local`. Prices are integer IDR.
import { FAKE_AREAS } from "../providers.ts";
import type { Theme } from "../content.ts";

export const DEMO_EMAIL_DOMAIN = "demo.bukalaris.local";
/** Shared local-only password for every demo login (documented in docs/DEMO.md). */
export const DEMO_PASSWORD = "bukalaris-demo-123";
/** Every demo store slug starts with this; it is the marker the seed uses to detect and reset itself. */
export const DEMO_SLUG_PREFIX = "demo-";

export type DemoVariant = { title: string; price: number; stock: number; sku?: string };
export type DemoProduct = {
  title: string;
  slug: string;
  description: string;
  variants: DemoVariant[];
  /** Collection keys this product belongs to. */
  tags: string[];
  draft?: boolean;
};
export type DemoCollection = { key: string; title: string; slug: string; description: string; status?: "draft" | "published" };
export type DemoStore = {
  slug: string;
  name: string;
  description: string;
  whatsapp: string;
  theme: Theme;
  /** Base hue for the generated product images. */
  hue: number;
  pickup: { areaId: string; areaLabel: string; addressText: string };
  owner: { email: string; name: string };
  staff: { email: string; name: string };
  products: DemoProduct[];
  collections: DemoCollection[];
  /** Ad destinations with obviously fake ids; tokens are placeholders, delivery stays simulated. */
  signals?: { meta?: string; tiktok?: string; google?: { tagId: string; label: string } };
};

const area = (i: number) => ({ areaId: FAKE_AREAS[i]!.id, areaLabel: FAKE_AREAS[i]!.label });

export const DEMO_ADMIN = { email: `admin@${DEMO_EMAIL_DOMAIN}`, name: "Operator Demo Bukalaris" };

export const DEMO_STORES: DemoStore[] = [
  {
    slug: "demo-batik-nusantara",
    name: "Batik Nusantara",
    description: "Batik tulis dan cap dari pengrajin lokal, plus kaos katun nyaman untuk harian. Produksi kecil, jahitan rapi, dikirim dari Bandung.",
    whatsapp: "0812-0000-0101",
    theme: "responsive",
    hue: 22,
    pickup: { ...area(0), addressText: "Jl. Contoh Kenanga No. 21, Sumur Bandung, Bandung 40111" },
    owner: { email: `owner-batik@${DEMO_EMAIL_DOMAIN}`, name: "Dewi Larasati" },
    staff: { email: `staff-batik@${DEMO_EMAIL_DOMAIN}`, name: "Rudi Hartono" },
    signals: { meta: "100000000000001", tiktok: "DEMOPIXEL000000001", google: { tagId: "AW-000000001", label: "demo_purchase" } },
    collections: [
      { key: "batik", title: "Koleksi Batik", slug: "koleksi-batik", description: "Kemeja, blus, rok dan kain batik dari pengrajin mitra kami." },
      { key: "kaos", title: "Kaos & Casual", slug: "kaos-casual", description: "Kaos katun combed dan aksesori santai untuk harian." },
      { key: "baru", title: "Produk Terbaru", slug: "terbaru", description: "Rilisan terbaru bulan ini." },
    ],
    products: [
      { title: "Kemeja Batik Parang Lengan Panjang", slug: "kemeja-batik-parang-lengan-panjang", tags: ["batik", "baru"], description: "Kemeja batik cap motif parang klasik, bahan katun primisima yang adem dan tidak mudah luntur. Potongan regular fit, cocok untuk kantor maupun acara formal.\n\n- Bahan: katun primisima\n- Kancing kayu kelapa\n- Cuci tangan, jemur terbalik", variants: [{ title: "M", price: 189_000, stock: 12, sku: "BTK-PRG-M" }, { title: "L", price: 189_000, stock: 15, sku: "BTK-PRG-L" }, { title: "XL", price: 199_000, stock: 8, sku: "BTK-PRG-XL" }] },
      { title: "Kemeja Batik Mega Mendung Lengan Pendek", slug: "kemeja-batik-mega-mendung", tags: ["batik"], description: "Motif mega mendung khas Cirebon dengan gradasi biru. Lengan pendek, nyaman dipakai seharian di cuaca panas.", variants: [{ title: "M", price: 165_000, stock: 10 }, { title: "L", price: 165_000, stock: 9 }, { title: "XL", price: 175_000, stock: 4 }] },
      { title: "Blus Batik Kawung Wanita", slug: "blus-batik-kawung", tags: ["batik", "baru"], description: "Blus batik motif kawung dengan kerah V dan lengan 3/4. Bahan katun halus, jatuh dan tidak menerawang.", variants: [{ title: "S", price: 149_000, stock: 6 }, { title: "M", price: 149_000, stock: 11 }, { title: "L", price: 149_000, stock: 7 }] },
      { title: "Kaos Katun Combed 30s Polos", slug: "kaos-katun-combed-30s-polos", tags: ["kaos"], description: "Kaos polos katun combed 30s, jahitan rantai, tidak melar setelah dicuci. Tersedia empat warna dasar.", variants: [{ title: "Hitam", price: 69_000, stock: 40, sku: "KS-30S-BLK" }, { title: "Putih", price: 69_000, stock: 35, sku: "KS-30S-WHT" }, { title: "Navy", price: 69_000, stock: 22, sku: "KS-30S-NVY" }, { title: "Maroon", price: 69_000, stock: 18, sku: "KS-30S-MRN" }] },
      { title: "Kaos Sablon Nusantara", slug: "kaos-sablon-nusantara", tags: ["kaos", "baru"], description: "Kaos katun combed dengan sablon plastisol motif peta Nusantara. Sablon tebal, tahan puluhan kali cuci.", variants: [{ title: "M", price: 89_000, stock: 14 }, { title: "L", price: 89_000, stock: 16 }, { title: "XL", price: 95_000, stock: 9 }] },
      { title: "Outer Batik Lurik", slug: "outer-batik-lurik", tags: ["batik"], description: "Outer tanpa kancing dengan kombinasi lurik tenun dan batik cap. Satu ukuran, pas untuk S sampai L.", variants: [{ title: "All size", price: 175_000, stock: 7 }] },
      { title: "Rok Lilit Batik Sogan", slug: "rok-lilit-batik-sogan", tags: ["batik"], description: "Rok lilit praktis dengan tali pinggang, warna sogan cokelat klasik. Panjang 95 cm.", variants: [{ title: "All size", price: 135_000, stock: 9 }] },
      { title: "Kain Batik Cap 2 Meter", slug: "kain-batik-cap-2-meter", tags: ["batik"], description: "Kain batik cap ukuran 2 x 1,15 meter, siap dijahit menjadi kemeja atau rok. Pilihan warna sogan dan indigo.", variants: [{ title: "Sogan", price: 120_000, stock: 20 }, { title: "Indigo", price: 125_000, stock: 13 }] },
      { title: "Celana Kulot Batik", slug: "celana-kulot-batik", tags: ["batik"], description: "Kulot batik dengan pinggang karet belakang dan saku samping. Bahan rayon adem.", variants: [{ title: "M", price: 139_000, stock: 8 }, { title: "L", price: 139_000, stock: 6 }] },
      { title: "Scarf Batik Motif Truntum", slug: "scarf-batik-truntum", tags: ["batik", "kaos"], description: "Scarf 90 x 90 cm motif truntum, bahan satin halus. Bisa jadi bandana, ikat tas, atau syal.", variants: [{ title: "Satu ukuran", price: 59_000, stock: 25 }] },
      { title: "Totebag Kanvas Motif Batik", slug: "totebag-kanvas-batik", tags: ["kaos"], description: "Totebag kanvas 12 oz dengan tempelan kain batik perca. Muat laptop 14 inci.", variants: [{ title: "Natural", price: 45_000, stock: 30 }] },
      { title: "Daster Batik Rumahan", slug: "daster-batik-rumahan", tags: ["batik"], draft: true, description: "Daster batik lengan pendek untuk di rumah. Masih menunggu foto produk.", variants: [{ title: "All size", price: 65_000, stock: 0 }] },
    ],
  },
  {
    slug: "demo-dapur-bunda",
    name: "Dapur Bunda Frozen",
    description: "Frozen food rumahan tanpa pengawet: dimsum, risol, bakso, pempek dan bumbu siap masak. Dibuat harian, dikirim dengan ice gel.",
    whatsapp: "0812-0000-0202",
    theme: "mobile",
    hue: 8,
    pickup: { ...area(1), addressText: "Jl. Contoh Cempaka No. 8, Bandung Wetan, Bandung 40114" },
    owner: { email: `owner-dapur@${DEMO_EMAIL_DOMAIN}`, name: "Siti Rahayu" },
    staff: { email: `staff-dapur@${DEMO_EMAIL_DOMAIN}`, name: "Andi Pratama" },
    collections: [
      { key: "frozen", title: "Frozen Favorit", slug: "frozen-favorit", description: "Camilan beku paling laris, tinggal goreng atau kukus." },
      { key: "bumbu", title: "Bumbu & Sambal", slug: "bumbu-sambal", description: "Sambal botol dan bumbu siap masak buatan dapur sendiri." },
      { key: "hemat", title: "Paket Hemat Keluarga", slug: "paket-hemat", description: "Kemasan besar untuk stok seminggu." },
    ],
    products: [
      { title: "Dimsum Ayam Udang Frozen", slug: "dimsum-ayam-udang", tags: ["frozen", "hemat"], description: "Dimsum isi ayam dan udang segar, kulit tipis. Kukus 10 menit dari beku.\n\n- Tanpa pengawet dan MSG tambahan\n- Tahan 1 bulan di freezer", variants: [{ title: "Isi 10", price: 35_000, stock: 30 }, { title: "Isi 20", price: 65_000, stock: 20 }] },
      { title: "Risol Mayo Frozen", slug: "risol-mayo", tags: ["frozen", "hemat"], description: "Risol isi smoked beef, telur dan mayones. Goreng dengan api sedang sampai keemasan.", variants: [{ title: "Isi 10", price: 30_000, stock: 28 }, { title: "Isi 20", price: 55_000, stock: 15 }] },
      { title: "Nugget Ayam Homemade 500 g", slug: "nugget-ayam-homemade", tags: ["frozen"], description: "Nugget ayam dada tanpa tepung berlebih, cocok untuk bekal anak.", variants: [{ title: "500 g", price: 42_000, stock: 25 }] },
      { title: "Bakso Sapi Urat 500 g", slug: "bakso-sapi-urat", tags: ["frozen"], description: "Bakso sapi dengan urat, isi sekitar 25 butir. Rebus 5 menit dari beku.", variants: [{ title: "500 g", price: 58_000, stock: 18 }] },
      { title: "Siomay Bandung Frozen", slug: "siomay-bandung", tags: ["frozen", "hemat"], description: "Siomay ikan tenggiri lengkap dengan bumbu kacang terpisah.", variants: [{ title: "Isi 10", price: 32_000, stock: 22 }, { title: "Isi 25", price: 75_000, stock: 10 }] },
      { title: "Pempek Palembang Campur", slug: "pempek-palembang-campur", tags: ["frozen", "hemat"], description: "Campuran lenjer, kapal selam kecil dan adaan dengan cuko kental.", variants: [{ title: "Paket kecil", price: 45_000, stock: 16 }, { title: "Paket keluarga", price: 95_000, stock: 8 }] },
      { title: "Kebab Mini Frozen", slug: "kebab-mini", tags: ["frozen"], description: "Kebab mini isi daging sapi cincang dan sayur, tortilla lembut. Panggang 3 menit per sisi.", variants: [{ title: "Isi 10", price: 38_000, stock: 20 }] },
      { title: "Cireng Isi Ayam Suwir", slug: "cireng-isi-ayam-suwir", tags: ["frozen"], description: "Cireng renyah isi ayam suwir pedas manis.", variants: [{ title: "Isi 15", price: 25_000, stock: 35 }] },
      { title: "Sambal Bawang Botol 200 g", slug: "sambal-bawang-botol", tags: ["bumbu"], description: "Sambal bawang goreng dalam botol kaca, dimasak dengan minyak kelapa. Tahan 3 bulan di kulkas.", variants: [{ title: "Level 1 (sedang)", price: 28_000, stock: 24 }, { title: "Level 3 (pedas)", price: 28_000, stock: 19 }] },
      { title: "Bumbu Rendang Siap Masak 250 g", slug: "bumbu-rendang-siap-masak", tags: ["bumbu"], description: "Bumbu rendang halus untuk 1 kg daging. Tinggal tumis dan masak dengan santan.", variants: [{ title: "250 g", price: 24_000, stock: 30 }] },
      { title: "Bumbu Soto Ayam 150 g", slug: "bumbu-soto-ayam", tags: ["bumbu"], description: "Bumbu soto kuning lengkap dengan serai dan daun jeruk kering.", variants: [{ title: "150 g", price: 18_000, stock: 26 }] },
      { title: "Donat Kentang Frozen", slug: "donat-kentang", tags: ["frozen"], draft: true, description: "Adonan donat kentang beku, tinggal goreng. Segera hadir.", variants: [{ title: "Isi 12", price: 35_000, stock: 0 }] },
    ],
  },
  {
    slug: "demo-glow-skin",
    name: "Glow Skin Lokal",
    description: "Perawatan kulit buatan lokal dengan formula ringan untuk iklim tropis. Semua produk kosmetik, bukan obat; cocokkan dengan kebutuhan kulit Anda.",
    whatsapp: "0812-0000-0303",
    theme: "responsive",
    hue: 325,
    pickup: { ...area(2), addressText: "Jl. Contoh Anggrek No. 45, Menteng, Jakarta Pusat 10330" },
    owner: { email: `owner-glow@${DEMO_EMAIL_DOMAIN}`, name: "Maya Putri" },
    staff: { email: `staff-glow@${DEMO_EMAIL_DOMAIN}`, name: "Fajar Nugroho" },
    collections: [
      { key: "wajah", title: "Perawatan Wajah", slug: "perawatan-wajah", description: "Rangkaian pembersih, toner, serum dan pelembap." },
      { key: "tubuh", title: "Perawatan Tubuh", slug: "perawatan-tubuh", description: "Lotion, scrub dan perawatan harian untuk tubuh." },
      { key: "paket", title: "Paket Hemat", slug: "paket-hemat", description: "Bundel lebih hemat dibanding beli satuan." },
    ],
    products: [
      { title: "Facial Wash Gentle Foam 100 ml", slug: "facial-wash-gentle-foam", tags: ["wajah"], description: "Sabun wajah berbusa lembut dengan pH seimbang, membersihkan tanpa rasa ketarik. Untuk semua jenis kulit.", variants: [{ title: "100 ml", price: 59_000, stock: 40 }] },
      { title: "Toner Hydrating Rose", slug: "toner-hydrating-rose", tags: ["wajah"], description: "Toner dengan air mawar dan gliserin untuk kulit terasa segar dan lembap setelah cuci muka.", variants: [{ title: "100 ml", price: 69_000, stock: 30 }, { title: "250 ml", price: 139_000, stock: 12 }] },
      { title: "Serum Niacinamide 5%", slug: "serum-niacinamide-5", tags: ["wajah"], description: "Serum ringan dengan niacinamide 5% dan zinc untuk tampilan kulit lebih merata. Gunakan pagi dan malam sebelum pelembap.", variants: [{ title: "20 ml", price: 89_000, stock: 25 }, { title: "30 ml", price: 119_000, stock: 14 }] },
      { title: "Moisturizer Gel Aloe 50 g", slug: "moisturizer-gel-aloe", tags: ["wajah"], description: "Pelembap bertekstur gel dengan ekstrak lidah buaya, cepat meresap dan tidak lengket.", variants: [{ title: "50 g", price: 79_000, stock: 28 }] },
      { title: "Sunscreen Daily SPF 30 PA++ 40 ml", slug: "sunscreen-daily-spf30", tags: ["wajah"], description: "Tabir surya harian bertekstur ringan tanpa white cast. Pakai ulang setiap 2-3 jam saat beraktivitas di luar.", variants: [{ title: "40 ml", price: 85_000, stock: 33 }] },
      { title: "Lip Balm Tinted", slug: "lip-balm-tinted", tags: ["wajah"], description: "Lip balm dengan shea butter dan sedikit warna natural.", variants: [{ title: "Cherry", price: 35_000, stock: 20 }, { title: "Peach", price: 35_000, stock: 17 }, { title: "Nude", price: 35_000, stock: 22 }] },
      { title: "Sheet Mask Set", slug: "sheet-mask-set", tags: ["wajah", "paket"], description: "Masker lembar dengan esens hyaluronic untuk kulit terasa lebih kenyal. Pakai 15 menit, 2-3 kali seminggu.", variants: [{ title: "Isi 5", price: 55_000, stock: 24 }, { title: "Isi 10", price: 99_000, stock: 11 }] },
      { title: "Body Lotion Vanilla 250 ml", slug: "body-lotion-vanilla", tags: ["tubuh"], description: "Lotion tubuh beraroma vanila lembut, melembapkan hingga 24 jam.", variants: [{ title: "250 ml", price: 65_000, stock: 26 }] },
      { title: "Face Mist Green Tea 60 ml", slug: "face-mist-green-tea", tags: ["wajah"], description: "Semprotan penyegar wajah dengan ekstrak teh hijau; aman di atas makeup.", variants: [{ title: "60 ml", price: 49_000, stock: 30 }] },
      { title: "Scrub Kopi Body 200 g", slug: "scrub-kopi-body", tags: ["tubuh"], description: "Lulur kopi dengan minyak kelapa untuk mengangkat sel kulit mati. Gunakan 1-2 kali seminggu.", variants: [{ title: "200 g", price: 52_000, stock: 21 }] },
      { title: "Paket Rangkaian Dasar", slug: "paket-rangkaian-dasar", tags: ["paket", "wajah"], description: "Facial wash, toner 100 ml dan moisturizer gel dalam satu paket. Hemat Rp 18.000 dibanding satuan.", variants: [{ title: "3 produk", price: 189_000, stock: 10 }] },
      { title: "Paket Perawatan Tubuh", slug: "paket-perawatan-tubuh", tags: ["paket", "tubuh"], description: "Body lotion vanilla dan scrub kopi. Hemat Rp 12.000.", variants: [{ title: "2 produk", price: 105_000, stock: 9 }] },
      { title: "Hair Oil Kemiri 50 ml", slug: "hair-oil-kemiri", tags: ["tubuh"], draft: true, description: "Minyak rambut kemiri. Menunggu label final.", variants: [{ title: "50 ml", price: 45_000, stock: 0 }] },
    ],
  },
  {
    slug: "demo-gadget-hub",
    name: "Gadget Hub Aksesoris",
    description: "Aksesori gadget pilihan: kabel, charger, power bank, audio dan perlengkapan meja kerja. Garansi tukar 7 hari untuk barang cacat.",
    whatsapp: "0812-0000-0404",
    theme: "mobile",
    hue: 215,
    pickup: { ...area(3), addressText: "Jl. Contoh Flamboyan No. 112, Gubeng, Surabaya 60281" },
    owner: { email: `owner-gadget@${DEMO_EMAIL_DOMAIN}`, name: "Bayu Saputra" },
    staff: { email: `staff-gadget@${DEMO_EMAIL_DOMAIN}`, name: "Nina Kurnia" },
    signals: { meta: "100000000000004" },
    collections: [
      { key: "daya", title: "Pengisian Daya", slug: "pengisian-daya", description: "Kabel, adaptor dan power bank." },
      { key: "audio", title: "Audio", slug: "audio", description: "Earphone dan speaker nirkabel." },
      { key: "meja", title: "Aksesori Meja Kerja", slug: "aksesori-meja-kerja", description: "Perlengkapan WFH dan konten kreator." },
    ],
    products: [
      { title: "Kabel Data USB-C Fast Charging", slug: "kabel-usb-c-fast-charging", tags: ["daya"], description: "Kabel USB-C ke USB-C 60 W dengan jaket nilon anyam. Mendukung transfer data 480 Mbps.", variants: [{ title: "1 m", price: 35_000, stock: 60, sku: "CB-C-1M" }, { title: "2 m", price: 49_000, stock: 40, sku: "CB-C-2M" }] },
      { title: "Charger Adaptor 20 W USB-C", slug: "charger-adaptor-20w", tags: ["daya"], description: "Adaptor dinding 20 W Power Delivery, ukuran ringkas, proteksi arus berlebih.", variants: [{ title: "Putih", price: 89_000, stock: 25 }, { title: "Hitam", price: 89_000, stock: 22 }] },
      { title: "Power Bank 10.000 mAh Slim", slug: "power-bank-10000-slim", tags: ["daya"], description: "Power bank tipis 10.000 mAh dengan dua port keluaran dan indikator LED. Berat 190 g.", variants: [{ title: "Hitam", price: 169_000, stock: 15 }, { title: "Biru", price: 169_000, stock: 9 }, { title: "Putih", price: 169_000, stock: 12 }] },
      { title: "Earphone TWS Bluetooth 5.3", slug: "earphone-tws-bluetooth-53", tags: ["audio"], description: "Earphone nirkabel dengan casing pengisi daya, total pemakaian hingga 24 jam, kontrol sentuh.", variants: [{ title: "Hitam", price: 199_000, stock: 18 }, { title: "Putih", price: 199_000, stock: 14 }] },
      { title: "Casing Silikon Bening", slug: "casing-silikon-bening", tags: ["meja"], description: "Casing TPU bening anti kuning dengan bumper sudut. Pilih sesuai ukuran layar ponsel.", variants: [{ title: "6,1 inci", price: 29_000, stock: 50 }, { title: "6,7 inci", price: 29_000, stock: 45 }] },
      { title: "Tempered Glass Full Cover", slug: "tempered-glass-full-cover", tags: ["meja"], description: "Pelindung layar kaca 9H dengan tepi hitam, lapisan anti sidik jari. Termasuk alat pemasangan.", variants: [{ title: "6,1 inci", price: 25_000, stock: 70 }, { title: "6,7 inci", price: 25_000, stock: 55 }] },
      { title: "Holder HP Mobil Magnetik", slug: "holder-hp-mobil-magnetik", tags: ["meja"], description: "Dudukan ponsel magnet kuat untuk kisi AC mobil, bisa diputar 360 derajat.", variants: [{ title: "Hitam", price: 55_000, stock: 30 }] },
      { title: "Tripod Mini Fleksibel", slug: "tripod-mini-fleksibel", tags: ["meja"], description: "Tripod kaki fleksibel dengan penjepit ponsel dan remote Bluetooth.", variants: [{ title: "Hitam", price: 45_000, stock: 24 }] },
      { title: "Mouse Wireless Silent Click", slug: "mouse-wireless-silent-click", tags: ["meja"], description: "Mouse nirkabel 2,4 GHz dengan klik senyap dan DPI 800/1200/1600.", variants: [{ title: "Hitam", price: 79_000, stock: 20 }, { title: "Abu-abu", price: 79_000, stock: 16 }] },
      { title: "Keyboard Bluetooth Mini", slug: "keyboard-bluetooth-mini", tags: ["meja"], description: "Keyboard Bluetooth 65% dengan baterai isi ulang, bisa terhubung ke 3 perangkat.", variants: [{ title: "Putih", price: 189_000, stock: 11 }] },
      { title: "Stand Laptop Aluminium Lipat", slug: "stand-laptop-aluminium-lipat", tags: ["meja"], description: "Penyangga laptop aluminium dengan 6 tingkat ketinggian, muat laptop 11-17 inci.", variants: [{ title: "Silver", price: 149_000, stock: 13 }] },
      { title: "Ring Light 10 Inci", slug: "ring-light-10-inci", tags: ["meja"], description: "Lampu ring 10 inci dengan 3 mode warna, 10 tingkat kecerahan dan tripod meja.", variants: [{ title: "Hitam", price: 125_000, stock: 10 }] },
      { title: "Strap Smartwatch Silikon 22 mm", slug: "strap-smartwatch-silikon-22", tags: ["meja"], description: "Tali jam pintar silikon 22 mm dengan quick release pin.", variants: [{ title: "Hitam", price: 39_000, stock: 30 }, { title: "Navy", price: 39_000, stock: 25 }, { title: "Merah", price: 39_000, stock: 18 }] },
      { title: "Speaker Bluetooth Mini", slug: "speaker-bluetooth-mini", tags: ["audio"], draft: true, description: "Speaker portabel 5 W, tahan cipratan air. Menunggu stok masuk.", variants: [{ title: "Hitam", price: 149_000, stock: 0 }] },
    ],
  },
];

/** CMS pages every demo store publishes (markdown-lite). */
export function demoPages(store: DemoStore): { title: string; slug: string; body: string }[] {
  return [
    {
      title: "Tentang Kami",
      slug: "tentang-kami",
      body: `# Tentang ${store.name}\n\n${store.description}\n\nKami usaha kecil yang mengerjakan semuanya sendiri: memilih bahan, mengemas, dan membalas pesan Anda. Setiap pesanan dikemas dari ${store.pickup.areaLabel.split(",").slice(-2).join(",").trim()}.\n\n## Hubungi kami\n\n- WhatsApp: ${store.whatsapp} (jam 09.00-20.00 WIB)\n- Email: halo@${store.slug}.demo.bukalaris.local`,
    },
    {
      title: "Cara Belanja",
      slug: "cara-belanja",
      body: `# Cara belanja di ${store.name}\n\n1. Pilih produk dan varian, lalu klik **Tambah ke keranjang**.\n2. Buka keranjang dan klik **Checkout**.\n3. Isi nama, nomor HP, dan alamat lengkap, lalu cari kelurahan tujuan.\n4. Pilih kurir dan metode bayar: **COD** (bayar saat barang tiba) atau **transfer**.\n5. Untuk COD, kami menghubungi Anda lewat telepon/WhatsApp sebelum pesanan dikirim.\n6. Nomor resi dikirim lewat email (jika diisi) dan bisa dilihat di tautan status pesanan.\n\n## Estimasi kirim\n\nPesanan yang dikonfirmasi sebelum pukul 14.00 WIB dikirim di hari yang sama (Senin-Sabtu).`,
    },
    {
      title: "Kebijakan Pengembalian",
      slug: "kebijakan-pengembalian",
      body: `# Kebijakan pengembalian\n\nKami menerima pengembalian dalam **7 hari** sejak paket diterima untuk kondisi berikut:\n\n- Barang rusak atau cacat saat diterima\n- Barang yang dikirim tidak sesuai pesanan\n\n## Cara mengajukan\n\n1. Rekam video saat membuka paket (unboxing) sebagai bukti.\n2. Hubungi kami lewat WhatsApp ${store.whatsapp} dengan nomor pesanan Anda.\n3. Kami kirim instruksi pengembalian; ongkir pengembalian kami tanggung bila kesalahan dari kami.\n\nBarang yang sudah dipakai atau segelnya dibuka tidak dapat dikembalikan, kecuali cacat produksi.`,
    },
  ];
}

export type DemoBuyer = { name: string; phone: string; address: string; email?: string; areaIndex: number };
/** Fictional buyers; `areaIndex` points into FAKE_AREAS (4 = Wamena: no COD). */
export const DEMO_BUYERS: DemoBuyer[] = [
  { name: "Budi Santoso", phone: "081200001001", address: "Jl. Contoh Melati No. 12, RT 03/RW 05, Bandung 40111", email: `budi.santoso@${DEMO_EMAIL_DOMAIN}`, areaIndex: 0 },
  { name: "Rina Wulandari", phone: "081200001002", address: "Jl. Contoh Dahlia No. 88, Bandung 40131", areaIndex: 1 },
  { name: "Agus Setiawan", phone: "081200001003", address: "Jl. Contoh Teratai No. 5, Jakarta Pusat 10310", email: `agus.setiawan@${DEMO_EMAIL_DOMAIN}`, areaIndex: 2 },
  { name: "Dewi Anggraini", phone: "081200001004", address: "Jl. Contoh Kamboja No. 27, Gubeng, Surabaya 60271", areaIndex: 3 },
  { name: "Hendra Gunawan", phone: "081200001005", address: "Jl. Contoh Seroja No. 14, Bandung 40115", email: `hendra.gunawan@${DEMO_EMAIL_DOMAIN}`, areaIndex: 0 },
  { name: "Lina Marlina", phone: "081200001006", address: "Jl. Contoh Bougenville No. 70, Jakarta Pusat 10330", areaIndex: 2 },
  { name: "Yusuf Hidayat", phone: "081200001007", address: "Jl. Contoh Asoka No. 9, Surabaya 60286", email: `yusuf.hidayat@${DEMO_EMAIL_DOMAIN}`, areaIndex: 3 },
  { name: "Putri Maharani", phone: "081200001008", address: "Jl. Contoh Tanjung No. 150, Bandung 40135", areaIndex: 0 },
  { name: "Eko Prasetyo", phone: "081200001009", address: "Jl. Contoh Cendana Kav. 25, Jakarta Pusat 10220", email: `eko.prasetyo@${DEMO_EMAIL_DOMAIN}`, areaIndex: 2 },
  { name: "Sari Dewi", phone: "081200001010", address: "Jl. Contoh Akasia No. 33, Surabaya 60234", areaIndex: 3 },
  { name: "Fitri Handayani", phone: "081200001011", address: "Jl. Contoh Kenari No. 60, Bandung 40111", email: `fitri.handayani@${DEMO_EMAIL_DOMAIN}`, areaIndex: 0 },
  { name: "Rizky Ramadhan", phone: "081200001012", address: "Jl. Contoh Sirih No. 18, Jakarta Pusat 10340", areaIndex: 2 },
  { name: "Wahyu Kurniawan", phone: "081200001013", address: "Jl. Contoh Matoa No. 4, Wamena 99511", email: `wahyu.kurniawan@${DEMO_EMAIL_DOMAIN}`, areaIndex: 4 },
  { name: "Nurul Aini", phone: "081200001014", address: "Jl. Contoh Palem No. 201, Bandung 40141", areaIndex: 1 },
  { name: "Dimas Saputra", phone: "081200001015", address: "Jl. Contoh Beringin No. 77, Surabaya 60282", areaIndex: 3 },
  // Deliberately short and without a house number: trips the COD "address incomplete" risk signal.
  { name: "Indah Permata", phone: "081200001016", address: "Jl. Contoh Mawar", areaIndex: 2 },
];
/** Index of the buyer whose address is incomplete (used once per store on a pending COD order). */
export const INCOMPLETE_ADDRESS_BUYER = DEMO_BUYERS.length - 1;
/** FAKE_AREAS index where no courier offers COD; buyers there always pay by transfer. */
export const NO_COD_AREA_INDEX = 4;
