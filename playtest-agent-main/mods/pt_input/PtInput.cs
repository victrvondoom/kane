// Method                                              Behaviour
// CanvasItem.GetGlobalMousePosition()                  Shared frame position
// CanvasItem.GetLocalMousePosition()                   Position minus GlobalPosition
// Viewport.GetMousePosition()                          Shared frame position
// DisplayServer.MouseGetPosition()                     WindowGetPosition() plus position
// Input.WarpMouse(Vector2)                             No operation
// Viewport.WarpMouse(Vector2)                          No operation
// Input.MouseMode setter                               No operation
using System;
using System.IO.MemoryMappedFiles;
using System.Runtime.Versioning;
using Godot;
using HarmonyLib;

[MegaCrit.Sts2.Core.Modding.ModInitializer("Init")]
[SupportedOSPlatform("windows")]
public static class PtInput
{
    private static readonly MemoryMappedFile Memory =
        MemoryMappedFile.CreateOrOpen($"pt_input_mouse_{System.Environment.ProcessId}", 8);
    private static readonly MemoryMappedViewAccessor View = Memory.CreateViewAccessor(0, 8);
    private static Vector2 Position() => new Vector2(View.ReadInt32(0), View.ReadInt32(4));

    public static void Init() => new Harmony("pt_input").PatchAll(typeof(PtInput).Assembly);

    [HarmonyPatch(typeof(CanvasItem), nameof(CanvasItem.GetGlobalMousePosition))]
    private static class GlobalMouse
    {
        private static bool Prefix(ref Vector2 __result) { __result = Position(); return false; }
    }
    [HarmonyPatch(typeof(CanvasItem), nameof(CanvasItem.GetLocalMousePosition))]
    private static class LocalMouse
    {
        private static bool Prefix(CanvasItem __instance, ref Vector2 __result)
        {
            Vector2 global = __instance is Control control ? control.GlobalPosition
                : __instance is Node2D node ? node.GlobalPosition : __instance.GetGlobalTransform().Origin;
            __result = Position() - global;
            return false;
        }
    }
    [HarmonyPatch(typeof(Viewport), nameof(Viewport.GetMousePosition))]
    private static class ViewportMouse
    {
        private static bool Prefix(ref Vector2 __result) { __result = Position(); return false; }
    }
    [HarmonyPatch(typeof(DisplayServer), nameof(DisplayServer.MouseGetPosition))]
    private static class DisplayMouse
    {
        private static bool Prefix(ref Vector2I __result)
        {
            Vector2 p = Position();
            __result = DisplayServer.WindowGetPosition() + new Vector2I((int)p.X, (int)p.Y);
            return false;
        }
    }
    [HarmonyPatch(typeof(Input), nameof(Input.WarpMouse), new Type[] { typeof(Vector2) })]
    private static class InputWarp
    {
        private static bool Prefix() => false;
    }
    [HarmonyPatch(typeof(Viewport), nameof(Viewport.WarpMouse), new Type[] { typeof(Vector2) })]
    private static class ViewportWarp
    {
        private static bool Prefix() => false;
    }
    [HarmonyPatch(typeof(Input), nameof(Input.MouseMode), MethodType.Setter)]
    private static class MouseMode
    {
        private static bool Prefix() => false;
    }
}
