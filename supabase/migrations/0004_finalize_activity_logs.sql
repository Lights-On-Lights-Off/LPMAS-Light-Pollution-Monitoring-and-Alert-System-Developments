-- ============================================================
-- LPMAS STEP 3
-- Finalize Activity Logs
--
-- Roles:
--   admin
--   manager
--
-- Activity logs are user/system actions.
-- Hardware readings remain in Raspberry Pi SQLite.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Make sure RLS is enabled
-- ------------------------------------------------------------

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 2. Remove the old activity-log SELECT policy
-- ------------------------------------------------------------

DROP POLICY IF EXISTS
    "Managers and admins can view activity logs"
ON public.activity_logs;


-- ------------------------------------------------------------
-- 3. Managers and admins can view activity logs
--
-- The user's role is obtained from their own profile.
-- We do NOT trust the role stored in the activity row
-- to determine what the current user is allowed to see.
-- ------------------------------------------------------------

CREATE POLICY
    "Managers and admins can view activity logs"
ON public.activity_logs
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.profiles p
        WHERE p.id = auth.uid()
          AND p.role IN ('admin'::user_role, 'manager'::user_role)
    )
);


-- ------------------------------------------------------------
-- 4. No direct INSERT policy
--
-- Activity records must be created through log_activity().
-- This prevents the frontend from directly inserting
-- arbitrary usernames, roles, or audit information.
-- ------------------------------------------------------------


-- ------------------------------------------------------------
-- 5. Recreate log_activity() with the final role model
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_activity(
    p_action text,
    p_resource text DEFAULT NULL::text,
    p_resource_id text DEFAULT NULL::text,
    p_details jsonb DEFAULT NULL::jsonb
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


    -- Insert the audit record.
    INSERT INTO public.activity_logs (
        user_id,
        username,
        role,
        action,
        resource,
        resource_id,
        details
    )
    VALUES (
        v_user_id,
        v_username,
        v_role,
        p_action,
        p_resource,
        p_resource_id,
        p_details
    )
    RETURNING id
    INTO v_id;


    RETURN v_id;

END;
$function$;


-- ------------------------------------------------------------
-- 6. Restrict RPC execution
--
-- Anonymous users cannot call log_activity().
-- Authenticated users can call it.
-- The function itself verifies the user's profile/role.
-- ------------------------------------------------------------

REVOKE ALL
ON FUNCTION public.log_activity(text, text, text, jsonb)
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.log_activity(text, text, text, jsonb)
TO authenticated;


-- ------------------------------------------------------------
-- 7. Useful index for Activity Logs
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS
    idx_activity_logs_created_at
ON public.activity_logs(created_at DESC);


CREATE INDEX IF NOT EXISTS
    idx_activity_logs_user_id
ON public.activity_logs(user_id);


CREATE INDEX IF NOT EXISTS
    idx_activity_logs_role
ON public.activity_logs(role);