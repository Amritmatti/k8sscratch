-- Employee records schema.
--
-- Constraints live in the database as well as the API. Validation in the
-- application protects the user experience; constraints here protect the data
-- from anything that reaches Postgres by another route (a migration, a manual
-- fix, a future service).

CREATE TABLE IF NOT EXISTS employees (
    id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         TEXT        NOT NULL,
    dob          DATE        NOT NULL,
    designation  TEXT        NOT NULL,
    doj          DATE        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT employees_name_not_blank
        CHECK (length(btrim(name)) BETWEEN 1 AND 120),

    CONSTRAINT employees_designation_not_blank
        CHECK (length(btrim(designation)) BETWEEN 1 AND 120),

    -- A date of birth in the future, or implying an age over 120, is a typo.
    CONSTRAINT employees_dob_realistic
        CHECK (dob < CURRENT_DATE AND dob > CURRENT_DATE - INTERVAL '120 years'),

    -- Nobody joins before they are born, and a joining date far in the future
    -- is almost always a mistyped year.
    CONSTRAINT employees_doj_after_dob
        CHECK (doj > dob),

    CONSTRAINT employees_doj_not_far_future
        CHECK (doj <= CURRENT_DATE + INTERVAL '1 year')
);

-- Listings are ordered by id and filtered by name or designation.
CREATE INDEX IF NOT EXISTS employees_name_idx
    ON employees (lower(name));

CREATE INDEX IF NOT EXISTS employees_designation_idx
    ON employees (lower(designation));

CREATE INDEX IF NOT EXISTS employees_doj_idx
    ON employees (doj DESC);

-- Keep updated_at honest without trusting the application to set it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_set_updated_at ON employees;

CREATE TRIGGER employees_set_updated_at
    BEFORE UPDATE ON employees
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
