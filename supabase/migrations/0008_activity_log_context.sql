-- ============================================================
-- LPMAS STEP 8
-- Add page / browser / IP context to activity_logs
--
-- Replaces the old NAVIGATE-action approach (one noisy row per
-- sidebar click) with a "Page" column on every real action row,
-- showing which page the action was taken on. Also records the
-- browser (reported by the client) and the caller's IP address
-- (read from the PostgREST request headers, since the frontend
-- itself cannot see its own public IP).
-- ============================================================


-- ------------------------------------------------------------
-- 1. New columns
-- ------------------------------------------------------------

ALTER TABLE public.activity_logs
    ADD COLUMN IF NOT EXISTS page text,
    ADD COLUMN IF NOT EXISTS browser text,
    ADD COLUMN IF NOT EXISTS ip_address text;


-- ------------------------------------------------------------
-- 2. Remove legacy NAVIGATE rows (one-time cleanup)
--
-- NAVIGATE was logged on every sidebar click and is being
-- retired in favor of the "page" column on real actions.
-- This DELETE already has a WHERE clause, so it is unaffected
-- by the pg_safeupdate extension.
-- ------------------------------------------------------------

DELETE FROM public.activity_logs WHERE action = 'NAVIGATE';


-- ------------------------------------------------------------
-- 3. Recreate log_activity() to accept + store the new context
--
-- p_page / p_browser come from the client (the frontend knows
-- which page it's on and can ask the browser to identify
-- itself). The IP address cannot be supplied by the client
-- (a page cannot see its own public IP), so it is read
-- server-side from the request headers that PostgREST exposes
-- via the request.headers setting, preferring the standard
-- proxy headers used by Cloudflare/most reverse proxies.
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_activity(
    p_action text,
    p_resource text DEFAULT NULL::text,
    p_resource_id text DEFAULT NULL::text,
    p_details jsonb DEFAULT NULL::jsonb,
    p_page text DEFAULT NULL::text,
    p_browser text DEFAULT NULL::text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid;
    v_username text;
    v_role text;
    v_id bigint;
    v_headers json;
    v_ip text;
BEGIN

    -- Get the authenticated Supabase user.
    v_user_id := auth.uid();

    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;


    -- Get the user's profile information.
    SELECT
        p.full_name,
        p.role::text
    INTO
        v_username,
        v_role
    FROM public.profiles p
    WHERE p.id = v_user_id;


    IF v_role IS NULL THEN
        RAISE EXCEPTION 'User profile not found';
    END IF;


    -- Only the current role architecture is allowed.
    IF v_role NOT IN ('admin', 'manager') THEN
        RAISE EXCEPTION 'Invalid user role';
    END IF;


    -- Best-effort IP address from the request PostgREST received.
    -- cf-connecting-ip (Cloudflare) is preferred when present; otherwise
    -- fall back to the first hop of x-forwarded-for. Direct/local
    -- connections (no proxy headers at all) fall back to "::1" via
    -- inet_client_addr(), same as a direct psql connection would show.
    BEGIN
        v_headers := current_setting('request.headers', true)::json;
    EXCEPTION WHEN OTHERS THEN
        v_headers := NULL;
    END;

    v_ip := COALESCE(
        v_headers ->> 'cf-connecting-ip',
        NULLIF(split_part(COALESCE(v_headers ->> 'x-forwarded-for', ''), ',', 1), ''),
        inet_client_addr()::text
    );


    -- Insert the audit record.
    INSERT INTO public.activity_logs (
        user_id,
        username,
        role,
        action,
        resource,
        resource_id,
        details,
        page,
        browser,
        ip_address
    )
    VALUES (
        v_user_id,
        v_username,
        v_role,
        p_action,
        p_resource,
        p_resource_id,
        p_details,
        p_page,
        p_browser,
        v_ip
    )
    RETURNING id
    INTO v_id;


    RETURN v_id;

END;
$function$;


-- ------------------------------------------------------------
-- 4. Restrict RPC execution (same as before, new signature)
-- ------------------------------------------------------------

REVOKE ALL
ON FUNCTION public.log_activity(text, text, text, jsonb, text, text)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.log_activity(text, text, text, jsonb, text, text)
TO authenticated;


-- ------------------------------------------------------------
-- 5. Drop the old 4-argument overload
--
-- Postgres allows function overloading by argument count, so
-- without this the old 4-argument log_activity(...) would keep
-- working (with NULL page/browser/ip) alongside the new one.
-- Removing it forces every caller onto the new signature.
-- ------------------------------------------------------------

DROP FUNCTION IF EXISTS public.log_activity(text, text, text, jsonb);


NOTIFY pgrst, 'reload schema';
