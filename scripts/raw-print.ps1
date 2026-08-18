# Sends a file of raw bytes straight to a Windows printer queue as RAW data,
# bypassing the driver's rendering. The POS58 speaks ESC/POS; anything the
# driver "helpfully" rasterises would come out as a picture of a receipt
# instead of a receipt, so RAW is the only correct datatype here.
#
#   powershell -File raw-print.ps1 -PrinterName "POS58 Printer" -FilePath job.bin
#
# Uses P/Invoke into winspool.drv, which means no native npm module and nothing
# to compile on the store PC.

param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$FilePath,
  [string]$DocName = "Ticket"
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public class DOCINFOW
    {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool OpenPrinter(string pPrinterName, out IntPtr hPrinter, IntPtr pDefault);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level,
        [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static void Send(string printerName, byte[] bytes, string docName)
    {
        IntPtr hPrinter;
        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for: " + printerName);

        try
        {
            DOCINFOW di = new DOCINFOW();
            di.pDocName = docName;
            di.pDataType = "RAW";

            if (!StartDocPrinter(hPrinter, 1, di))
                throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");

            try
            {
                if (!StartPagePrinter(hPrinter))
                    throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");

                IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);
                try
                {
                    Marshal.Copy(bytes, 0, buffer, bytes.Length);
                    int written;
                    if (!WritePrinter(hPrinter, buffer, bytes.Length, out written))
                        throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
                    if (written != bytes.Length)
                        throw new Exception("Short write: " + written + " of " + bytes.Length);
                }
                finally { Marshal.FreeCoTaskMem(buffer); }

                EndPagePrinter(hPrinter);
            }
            finally { EndDocPrinter(hPrinter); }
        }
        finally { ClosePrinter(hPrinter); }
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::Send($PrinterName, $bytes, $DocName)
Write-Output "OK $($bytes.Length)"
