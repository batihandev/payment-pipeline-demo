-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 0;

-- Every update raises the version by one, whichever service writes the row.
CREATE FUNCTION "payments_bump_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."version" := OLD."version" + 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER "payments_version"
BEFORE UPDATE ON "payments"
FOR EACH ROW EXECUTE FUNCTION "payments_bump_version"();
