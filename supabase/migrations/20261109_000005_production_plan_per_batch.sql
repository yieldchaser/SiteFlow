-- Data correction: a production batch plans material for its own size.
-- Idempotent (the result depends only on the recipe and the batch).
--
-- Batches saved before this fix stored the recipe's per-unit quantity as the
-- batch plan (8 bags of cement per 1 cum, whatever the batch size), so a
-- 5 cum batch that used 41 bags read 33 bags over plan instead of 1. The plan
-- is rebuilt from the recipe: per unit x batch planned output x (1 + wastage).

UPDATE "production_batch_materials" AS bm
SET "planned_qty" = rm."planned_qty" / NULLIF(r."target_output_qty", 0) * b."planned_output_qty" * (1 + COALESCE(r."wastage_pct", 0) / 100),
    "variance_qty" = bm."actual_qty" - rm."planned_qty" / NULLIF(r."target_output_qty", 0) * b."planned_output_qty" * (1 + COALESCE(r."wastage_pct", 0) / 100)
FROM "production_batches" AS b
JOIN "production_recipes" AS r ON r."id" = b."recipe_id"
JOIN "production_recipe_materials" AS rm ON rm."recipe_id" = r."id"
WHERE bm."batch_id" = b."id"
  AND rm."material_name" = bm."material_name"
  AND r."target_output_qty" > 0;

UPDATE "production_batches" AS b
SET "planned_material_qty" = s."planned",
    "consumption_variance_qty" = b."actual_material_qty" - s."planned"
FROM (
    SELECT "batch_id", SUM("planned_qty") AS "planned"
    FROM "production_batch_materials"
    GROUP BY "batch_id"
) AS s
WHERE s."batch_id" = b."id";
