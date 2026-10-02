# ADR 011: Device-bound admission QR images

**Status:** accepted, 2026-09-28

## Context

An admission package contains a signed role credential and encrypted unit-key grants for one specific joining device.
The previous interface required the Master to send that long package as text. Real messaging applications can wrap or
truncate long messages, and the Master's screen looked successful before the joining device had imported the package.
A four- or five-digit replacement cannot securely carry this material and, without a server, cannot retrieve it.

## Decision

After the Master imports a joining device's public join request, selects its role, and taps **Admit**, A.R.G.U.S. gzip
compresses the existing signed admission code and displays it as a QR image. The Master may show that image directly
or share/save the PNG for a remote member. The pending device can use its camera or photo library to read the image;
decoding happens locally and the existing target-device, authority-signature, credential, and encrypted-key checks are
unchanged. Copy and paste remains behind a fallback disclosure for accessibility and older browsers.

The QR is an invitation to one already-identified device, not a short authorization secret. Hiding it does not revoke
an image that was already shared. Long-term access begins only after the intended device imports it and persists until
the member expires or a Master revokes it. Sharing the image through a third-party messenger may leave a retained copy,
but that copy cannot admit another device because the encrypted grants and credential subject are device-bound.

## Consequences

The common flow no longer asks a person to copy a fragile cryptographic string. It works in person and remotely without
adding a server, database, public rendezvous record, or plaintext identifying chain metadata. A later admission-
confirmation event is still needed if the Master must distinguish “invitation issued” from “device activated” across
devices; wallet funding and the member ledger entry remain evidence that the invitation was issued, not accepted.
