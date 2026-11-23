CREATE TABLE "seller_terms_review" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "seller_terms_review_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"version" integer NOT NULL,
	"adviser_name" text NOT NULL,
	"reviewed_on" date NOT NULL,
	"note" text NOT NULL,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_terms_review_chk" CHECK (length(btrim("seller_terms_review"."adviser_name")) between 2 and 200 and length(btrim("seller_terms_review"."note")) between 5 and 500 and length(btrim("seller_terms_review"."recorded_by")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "seller_terms_version" (
	"version" integer PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seller_terms_version_chk" CHECK ("seller_terms_version"."version" >= 1 and length(btrim("seller_terms_version"."title")) between 5 and 200 and length(btrim("seller_terms_version"."body")) between 50 and 20000 and length(btrim("seller_terms_version"."created_by")) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "store_terms_acceptance" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "store_terms_acceptance_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"store_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"accepted_by" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "store_terms_acceptance_uq" UNIQUE("store_id","version"),
	CONSTRAINT "store_terms_acceptance_actor_chk" CHECK (length(btrim("store_terms_acceptance"."accepted_by")) between 1 and 120)
);
--> statement-breakpoint
ALTER TABLE "seller_terms_review" ADD CONSTRAINT "seller_terms_review_version_seller_terms_version_version_fk" FOREIGN KEY ("version") REFERENCES "public"."seller_terms_version"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_terms_acceptance" ADD CONSTRAINT "store_terms_acceptance_store_id_store_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."store"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_terms_acceptance" ADD CONSTRAINT "store_terms_acceptance_version_seller_terms_version_version_fk" FOREIGN KEY ("version") REFERENCES "public"."seller_terms_version"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ===== T-116 seller terms, notices and privacy statements (PR-27, ADR-0013 section 8 & D-33, ADR-0015 decision 8, ADR-0016 decision 23) ===

-- 1. Privileges and FORCE RLS. Terms versions and adviser reviews are shared-read (written by the Owner console on the platform pool);
--    acceptances are store-scoped under FORCE RLS (written by the store owner on the app pool).
REVOKE ALL ON public.seller_terms_version, public.seller_terms_review, public.store_terms_acceptance FROM PUBLIC, bukalaris_app, bukalaris_platform;--> statement-breakpoint
GRANT SELECT ON public.seller_terms_version, public.seller_terms_review TO bukalaris_app;--> statement-breakpoint
GRANT SELECT, INSERT ON public.seller_terms_version, public.seller_terms_review TO bukalaris_platform;--> statement-breakpoint
ALTER TABLE public.store_terms_acceptance ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.store_terms_acceptance FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON public.store_terms_acceptance USING (store_id = public.app_store_id()) WITH CHECK (store_id = public.app_store_id());--> statement-breakpoint
GRANT SELECT, INSERT ON public.store_terms_acceptance TO bukalaris_app;--> statement-breakpoint
GRANT SELECT ON public.store_terms_acceptance TO bukalaris_platform;--> statement-breakpoint

-- 2. Append-only guards. Published versions and adviser reviews can never be edited or deleted (a change is a new version or review row).
CREATE FUNCTION public.seller_terms_immutable_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; publish a new row instead', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.seller_terms_immutable_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER seller_terms_version_append_only BEFORE UPDATE OR DELETE ON public.seller_terms_version FOR EACH ROW EXECUTE FUNCTION public.seller_terms_immutable_guard();--> statement-breakpoint
CREATE TRIGGER seller_terms_review_append_only BEFORE UPDATE OR DELETE ON public.seller_terms_review FOR EACH ROW EXECUTE FUNCTION public.seller_terms_immutable_guard();--> statement-breakpoint

-- 3. Store acceptance guard: append-only (never edited or deleted except by demo reset) and accepted only by an owner of that store.
CREATE FUNCTION public.store_terms_acceptance_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_catalog.current_setting('bukalaris.payment_evidence_reset', true) = 'demo' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'store_terms_acceptance is append-only and cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'store_terms_acceptance is append-only and cannot be edited' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.membership m WHERE m.store_id = NEW.store_id AND m.user_id = NEW.accepted_by AND m.role = 'owner') THEN
    RAISE EXCEPTION 'only an owner of the store can accept seller terms' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.store_terms_acceptance_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER store_terms_acceptance_guard BEFORE INSERT OR UPDATE OR DELETE ON public.store_terms_acceptance FOR EACH ROW EXECUTE FUNCTION public.store_terms_acceptance_guard();--> statement-breakpoint

-- 4. Seed version 1 (draft: no row in seller_terms_review yet, so the texts stay marked as draft and the production switches stay closed).
INSERT INTO public.seller_terms_version (version, title, body, created_by) VALUES (
  1,
  'Syarat Penjual Bukalaris (Model Akun Milik Penjual)',
  E'1. Uang pembeli masuk langsung ke rekening dan akun Anda.\nPembayaran pembeli (QRIS, virtual account, dan transfer bank) serta uang COD masuk langsung ke rekening bank dan akun penyedia milik toko Anda. Dana tersebut tidak pernah melalui, dipegang, ditahan, atau diteruskan oleh Bukalaris.\n\n2. Peran catatan Bukalaris.\nBukalaris hanya menyimpan catatan tertulis atas transaksi yang terjadi di platform sebagai arsip bagi toko Anda. Bukalaris tidak mencocokkan (merekonsiliasi), menjamin, atau menyelesaikan rekening bank, akun AutoLaris, maupun akun Mengantar milik Anda; pembukuan eksternal tetap menjadi tanggung jawab Anda.\n\n3. Uang pengiriman antara Anda dan Mengantar.\nSeluruh uang pengiriman — termasuk ongkos kirim, saldo dan isi ulang akun, pencairan COD, biaya COD, biaya retur, cashback, dan klaim kurir — diselesaikan langsung antara Anda dan Mengantar.\n\n4. Tanggung jawab akun penyedia dan data pembeli.\nAnda bertanggung jawab atas akun Mengantar dan AutoLaris milik toko Anda serta atas data pembeli yang tersimpan di akun penyedia tersebut sesuai ketentuan masing-masing penyedia. Bukalaris meneruskan data pembeli ke penyedia atas instruksi dan kunci toko Anda, dan bertanggung jawab atas salinan yang tersimpan di platform Bukalaris.\n\n5. Batas penghapusan data pembeli.\nPenghapusan atau penyamaran data kontak pembeli di Bukalaris hanya berlaku pada salinan di platform Bukalaris dan tidak menjangkau atau menghapus salinan data pembeli yang sudah terkirim ke akun Mengantar atau AutoLaris milik Anda.\n\n6. Hak atas konten produk digital.\nUntuk setiap produk digital yang Anda tampilkan atau jual, Anda menyatakan memegang hak yang sah untuk menjual dan membagikan konten tersebut serta bertanggung jawab penuh atas isi dan tautan akses yang Anda berikan kepada pembeli.\n\n7. Program afiliasi toko.\nApabila toko Anda mengaktifkan program afiliasi, komisi afiliasi menjadi kewajiban dan dibayarkan langsung oleh Anda kepada afiliator; Bukalaris tidak memegang, menjamin, atau menalangi komisi.',
  'migration:T-116'
) ON CONFLICT (version) DO NOTHING;--> statement-breakpoint

-- 5. Retention: acceptances are kept as legal/audit records (never purged by the generic purge).
INSERT INTO public.retention_class (class, table_name, time_column, row_filter) VALUES
  ('store_terms_acceptance', 'store_terms_acceptance', 'accepted_at', 'false')
ON CONFLICT (class) DO NOTHING;--> statement-breakpoint

-- 6. Demo reset includes store_terms_acceptance before deleting demo stores.
CREATE OR REPLACE FUNCTION public.reset_demo_payments(p_store_ids bigint[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_ids bigint[];
  v_total bigint := 0;
  v_n bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relnamespace = pg_catalog.pg_my_temp_schema() AND c.relname LIKE 'pg\_%') THEN
    RAISE EXCEPTION 'reset refused: a temporary relation shadows a system catalog' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT pg_catalog.array_agg(s.id) INTO v_ids FROM public.store s WHERE s.id = ANY (p_store_ids) AND s.slug LIKE 'demo-%';
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_catalog.set_config('bukalaris.payment_evidence_reset', 'demo', true);
  DELETE FROM public.store_terms_acceptance WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.bank_transfer_confirmation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_proof WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.order_bank_transfer WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.store_bank_account WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.store_bank_transfer WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.order_seller_refund WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_manual_confirmation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_anomaly WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.late_payment_obligation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_callback WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_observation WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_attempt_event WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  DELETE FROM public.payment_attempt WHERE store_id = ANY (v_ids);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_total := v_total + v_n;
  PERFORM pg_catalog.set_config('bukalaris.payment_evidence_reset', '', true);
  RETURN v_total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.reset_demo_payments(bigint[]) FROM PUBLIC, bukalaris_app, bukalaris_platform;