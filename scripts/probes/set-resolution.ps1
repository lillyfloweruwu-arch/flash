param([int]$Width, [int]$Height)
Add-Type @"
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
public struct DEVMODE {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmDeviceName;
  public short dmSpecVersion; public short dmDriverVersion; public short dmSize;
  public short dmDriverExtra; public int dmFields;
  public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
  public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption;
  public short dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=32)] public string dmFormName;
  public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight;
  public int dmDisplayFlags; public int dmDisplayFrequency;
  public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType;
  public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
}
public class Display {
  [DllImport("user32.dll", CharSet=CharSet.Ansi)] public static extern int EnumDisplaySettings(IntPtr d, int n, ref DEVMODE dm);
  [DllImport("user32.dll")] public static extern int ChangeDisplaySettings(ref DEVMODE dm, int flags);
}
"@
$dm = New-Object DEVMODE
$dm.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf($dm)
if ([Display]::EnumDisplaySettings([IntPtr]::Zero, -1, [ref]$dm) -eq 0) { Write-Output "enum failed"; exit 1 }
Write-Output "current: $($dm.dmPelsWidth)x$($dm.dmPelsHeight) @ $($dm.dmDisplayFrequency)Hz"
if ($Width -and $Height) {
  $dm.dmPelsWidth = $Width; $dm.dmPelsHeight = $Height
  $dm.dmFields = 0x80000 -bor 0x100000   # DM_PELSWIDTH | DM_PELSHEIGHT
  $result = [Display]::ChangeDisplaySettings([ref]$dm, 0)
  Write-Output "change to ${Width}x${Height}: $result (0 = ok)"
}
