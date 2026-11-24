/** Backward-compatible cover adapter over the shared DNS-pinned public fetcher. */
export {
  isPublicResourceAddress as isPublicCoverAddress,
  resolvePublicResourceAddress as resolvePublicCoverAddress,
  fetchPublicResource as fetchPublicCover,
  pinnedAddressLookup,
  responseFromIncoming,
} from "./public-resource-fetch";
