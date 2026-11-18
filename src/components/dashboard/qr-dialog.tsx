"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function QrDialog({
  open,
  onOpenChange,
  tableId,
  publicUrl,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tableId: string;
  publicUrl: string;
}) {
  const url = `${publicUrl}/guest/${tableId}`;
  const [dataUrl, setDataUrl] = useState<string>("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancel = false;
    QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: "#141414", light: "#ffffff" } })
      .then((value) => {
        if (!cancel) setDataUrl(value);
      })
      .catch(() => {
        if (!cancel) setDataUrl("");
      });
    return () => {
      cancel = true;
    };
  }, [url]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Table {tableId}</DialogTitle>
          <DialogDescription>Guests on the same network open this link. The code uses APP_PUBLIC_URL, not the manager browser host.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3">
          {dataUrl ? <img src={dataUrl} alt={`QR code for ${tableId}`} className="h-52 w-52 rounded-lg bg-white p-2" /> : <div className="h-52 w-52 rounded-lg bg-secondary" />}
          <input readOnly value={url} className="w-full rounded-md border bg-background px-2 py-1.5 text-xs" />
          <div className="flex w-full gap-2">
            <Button
              type="button"
              variant="secondary"
              className="flex-1"
              onClick={() => {
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              <Copy className="h-4 w-4" />
              {copied ? "Copied" : "Copy URL"}
            </Button>
            <Button type="button" className="flex-1" onClick={() => window.open(url, "_blank", "noopener")}>
              <ExternalLink className="h-4 w-4" />
              Open guest
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
