-- ============================================================
-- LPMAS STEP 3E
-- Fix profiles RLS recursion
--
-- Problem:
-- A profiles policy was checking the profiles table from
-- inside another profiles policy, causing:
--
--   infinite recursion detected in policy for relation "profiles"
--
-- Solution:
-- Use a SECURITY DEFINER helper to safely obtain the current
-- user's role without triggering profiles RLS again.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Create a safe helper for retrieving the current role
-- ------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
SET row_security = off
AS $function$
    SELECT p.role::text
    FROM public.profiles p
    WHERE p.id = auth.uid()
    LIMIT 1;
$function$;


-- ------------------------------------------------------------
-- 2. Do not allow anonymous users to use the helper
-- ------------------------------------------------------------

REVOKE ALL
ON FUNCTION public.current_user_role()
FROM PUBLIC;

GRANT EXECUTE
ON FUNCTION public.current_user_role()
TO authenticated;


-- ------------------------------------------------------------
-- 3. Remove the recursive Admin profile policy
-- ------------------------------------------------------------

DROP POLICY IF EXISTS
    "Admins can view all profiles"
ON public.profiles;


-- ------------------------------------------------------------
-- 4. Recreate Admin profile access using the helper
--
-- IMPORTANT:
-- This policy no longer queries public.profiles directly.
-- Therefore it cannot recursively invoke itself.
-- ------------------------------------------------------------

CREATE POLICY
    "Admins can view all profiles"
ON public.profiles
FOR SELECT
TO authenticated
USING (
    public.current_user_role() = 'admin'
);


-- ------------------------------------------------------------
-- 5. Ensure users can still view their own profile
-- ------------------------------------------------------------

DROP POLICY IF EXISTS
    "Users can view own profile"
ON public.profiles;

CREATE POLICY
    "Users can view own profile"
ON public.profiles
FOR SELECT
TO authenticated
USING (
    id = auth.uid()
);


-- ------------------------------------------------------------
-- 6. Make sure RLS remains enabled
-- ------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;


-- ------------------------------------------------------------
-- 7. Fix Activity Logs policy to use the same helper
--
-- This prevents activity_logs → profiles → profiles recursion.
-- ------------------------------------------------------------

DROP POLICY IF EXISTS
    "Managers and admins can view activity logs"
ON public.activity_logs;

CREATE POLICY
    "Managers and admins can view activity logs"
ON public.activity_logs
FOR SELECT
TO authenticated
USING (
    public.current_user_role() IN ('admin', 'manager')
);


-- ------------------------------------------------------------
-- 8. Verify current roles
-- ------------------------------------------------------------

SELECT
    id,
    full_name,
    role
FROM public.profiles
ORDER BY full_name;