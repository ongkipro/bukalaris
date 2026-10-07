import { mediaUrl } from "@/lib/media";
import type { Cover } from "@bukalaris/db";
import { ImageIcon } from "lucide-react";

type Props = { base: string; image: Cover | null | undefined; sizes?: string; priority?: boolean; className?: string; fallbackLabel?: string };

/**
 * Product image with reserved space (width/height from the stored header) or an honest
 * placeholder. Plain <img>: the image optimizer (sharp) is not part of this build.
 */
export function StoreImage({ base, image, priority = false, className = "", fallbackLabel = "Belum ada foto" }: Props) {
  if (!image) {
    return (
      <div role="img" aria-label={fallbackLabel} className={`flex items-center justify-center bg-muted text-muted-foreground ${className}`}>
        <ImageIcon className="size-8 opacity-50" aria-hidden />
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- local-disk media, no optimizer in this build
    <img
      src={mediaUrl(base, image.id)}
      alt={image.alt}
      width={image.width}
      height={image.height}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      fetchPriority={priority ? "high" : "auto"}
      className={`bg-muted object-cover ${className}`}
    />
  );
}
