ALTER TABLE "sources" ADD CONSTRAINT "uq_sources_id_brand" UNIQUE("id","brand_id");--> statement-breakpoint
ALTER TABLE "packages" ADD CONSTRAINT "fk_packages_source_brand" FOREIGN KEY ("source_id","brand_id") REFERENCES "public"."sources"("id","brand_id") ON DELETE no action ON UPDATE no action;
