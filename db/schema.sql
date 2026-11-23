SET LOCAL lock_timeout = '2s';
-- statement
CREATE TABLE IF NOT EXISTS public.pastes (
    id text PRIMARY KEY,
    content text NOT NULL,
    expires_at timestamptz,
    remaining_views bigint CHECK (remaining_views >= 0)
);
-- statement
LOCK TABLE public.pastes IN SHARE ROW EXCLUSIVE MODE;
-- statement
CREATE TABLE IF NOT EXISTS public.paste_storage (
    singleton boolean PRIMARY KEY CHECK (singleton),
    paste_count bigint NOT NULL CHECK (paste_count >= 0),
    content_bytes bigint NOT NULL CHECK (content_bytes >= 0),
    max_pastes bigint NOT NULL DEFAULT 10000 CHECK (max_pastes > 0),
    max_bytes bigint NOT NULL DEFAULT 67108864 CHECK (max_bytes > 0)
);
-- statement
INSERT INTO public.paste_storage (singleton, paste_count, content_bytes)
SELECT true, count(*), coalesce(sum(octet_length(content)), 0) FROM public.pastes
ON CONFLICT (singleton) DO UPDATE
SET paste_count = EXCLUDED.paste_count, content_bytes = EXCLUDED.content_bytes;
-- statement
CREATE INDEX IF NOT EXISTS pastes_expiry_idx ON public.pastes (expires_at)
WHERE expires_at IS NOT NULL;
-- statement
CREATE INDEX IF NOT EXISTS pastes_exhausted_idx ON public.pastes (id)
WHERE remaining_views = 0;
-- statement
CREATE OR REPLACE FUNCTION public.account_paste_storage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE public.paste_storage
        SET paste_count = paste_count + 1, content_bytes = content_bytes + octet_length(NEW.content)
        WHERE singleton AND paste_count < max_pastes
          AND content_bytes + octet_length(NEW.content) <= max_bytes;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Paste storage budget exceeded' USING ERRCODE = '23514';
        END IF;
    ELSE
        UPDATE public.paste_storage
        SET paste_count = paste_count - 1, content_bytes = content_bytes - octet_length(OLD.content)
        WHERE singleton;
    END IF;
    RETURN NULL;
END;
$$;
-- statement
CREATE OR REPLACE TRIGGER account_paste_storage
AFTER INSERT OR DELETE ON public.pastes
FOR EACH ROW EXECUTE FUNCTION public.account_paste_storage();
-- statement
CREATE OR REPLACE FUNCTION public.create_paste(
    p_id text, p_content text, p_expires_at timestamptz, p_remaining_views bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    -- Lock the single budget row so competing writers cannot oversubscribe it.
    PERFORM 1 FROM public.paste_storage WHERE singleton FOR UPDATE;

    DELETE FROM public.pastes WHERE id IN (
        SELECT id FROM public.pastes WHERE expires_at <= statement_timestamp()
        ORDER BY expires_at LIMIT 32 FOR UPDATE SKIP LOCKED
    );
    DELETE FROM public.pastes WHERE id IN (
        SELECT id FROM public.pastes WHERE remaining_views = 0
        ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED
    );

    IF NOT EXISTS (
        SELECT 1 FROM public.paste_storage
        WHERE singleton AND paste_count < max_pastes
          AND content_bytes + octet_length(p_content) <= max_bytes
    ) THEN
        RETURN false;
    END IF;

    INSERT INTO public.pastes (id, content, expires_at, remaining_views)
    VALUES (p_id, p_content, p_expires_at, p_remaining_views);
    RETURN true;
END;
$$;
-- statement
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'pastebin_runtime') THEN
        CREATE ROLE pastebin_runtime NOLOGIN;
    END IF;
END;
$$;
-- statement
REVOKE ALL ON public.pastes, public.paste_storage FROM PUBLIC;
-- statement
REVOKE ALL ON FUNCTION public.account_paste_storage() FROM PUBLIC;
-- statement
REVOKE ALL ON FUNCTION public.create_paste(text, text, timestamptz, bigint) FROM PUBLIC;
-- statement
GRANT USAGE ON SCHEMA public TO pastebin_runtime;
-- statement
GRANT SELECT, UPDATE (remaining_views) ON public.pastes TO pastebin_runtime;
-- statement
GRANT EXECUTE ON FUNCTION public.create_paste(text, text, timestamptz, bigint) TO pastebin_runtime;
