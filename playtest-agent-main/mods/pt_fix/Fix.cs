using HarmonyLib;

[MegaCrit.Sts2.Core.Modding.ModInitializer("Init")]
public static class PtFix
{
    public static void Init() => new Harmony("pt_fix").PatchAll(typeof(PtFix).Assembly);
}

// Add the target and a small Harmony patch here. The empty template changes nothing.
public static class TestPatch
{
}
