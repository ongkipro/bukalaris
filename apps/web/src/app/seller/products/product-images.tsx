import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MEDIA_MAX_PER_PRODUCT } from "@bukalaris/db";
import { ArrowUpIcon, Trash2Icon } from "lucide-react";
import { moveMediaUpAction, removeMediaAction, updateMediaAltAction, uploadMediaAction } from "./media-actions";

type Img = { id: number; alt: string; width: number; height: number; position: number };

export function ProductImages({ productId, images }: { productId: number; images: Img[] }) {
  return (
    <section id="gambar" aria-labelledby="gambar-h" className="grid gap-4">
      <div>
        <h2 id="gambar-h" className="text-lg font-semibold">Gambar</h2>
        <p className="text-sm text-muted-foreground">
          Gambar pertama jadi sampul. JPG, PNG atau WebP, maksimal 5 MB, {MEDIA_MAX_PER_PRODUCT} gambar per produk. Isi teks alternatif untuk pembaca layar dan SEO.
        </p>
      </div>
      {images.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="product-images">
          {images.map((img, i) => (
            <li key={img.id} className="grid grid-cols-[4rem_minmax(0,1fr)] gap-3 rounded-lg border p-3 sm:grid-cols-[6rem_minmax(0,1fr)]">
              {/* eslint-disable-next-line @next/next/no-img-element -- seller preview from local disk */}
              <img
                src={`/seller/products/${productId}/media/${img.id}`}
                alt={img.alt || `Gambar ${i + 1}`}
                width={img.width}
                height={img.height}
                loading="lazy"
                decoding="async"
                className="aspect-square w-full rounded-md bg-muted object-cover"
              />
              <div className="grid content-start gap-2">
                <form action={updateMediaAltAction.bind(null, productId, img.id)} className="grid gap-2">
                  <Label htmlFor={`alt_${img.id}`}>{i === 0 ? "Teks alternatif (sampul)" : `Teks alternatif gambar ${i + 1}`}</Label>
                  <div className="flex gap-2">
                    <Input id={`alt_${img.id}`} name={`alt_${img.id}`} maxLength={300} defaultValue={img.alt} placeholder="mis. Kaos hitam tampak depan" />
                    <Button type="submit" variant="outline" size="sm" className="h-8 shrink-0">Simpan</Button>
                  </div>
                </form>
                <div className="flex flex-wrap gap-2">
                  {i > 0 && (
                    <form action={moveMediaUpAction.bind(null, productId, img.id)}>
                      <Button type="submit" variant="ghost" size="sm" aria-label={`Naikkan gambar ${i + 1}`}>
                        <ArrowUpIcon data-icon="inline-start" aria-hidden /> Naikkan
                      </Button>
                    </form>
                  )}
                  <form action={removeMediaAction.bind(null, productId, img.id)}>
                    <Button type="submit" variant="destructive" size="sm" aria-label={`Hapus gambar ${i + 1}`}>
                      <Trash2Icon data-icon="inline-start" aria-hidden /> Hapus
                    </Button>
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {images.length < MEDIA_MAX_PER_PRODUCT && (
        <form action={uploadMediaAction.bind(null, productId)} className="grid gap-3 rounded-lg border border-dashed p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <div className="grid gap-2">
            <Label htmlFor="file">Berkas gambar</Label>
            <Input id="file" name="file" type="file" accept="image/jpeg,image/png,image/webp" required className="pt-1" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="alt">Teks alternatif</Label>
            <Input id="alt" name="alt" maxLength={300} placeholder="Apa yang terlihat di gambar" />
          </div>
          <Button type="submit" variant="outline">Unggah gambar</Button>
        </form>
      )}
    </section>
  );
}
