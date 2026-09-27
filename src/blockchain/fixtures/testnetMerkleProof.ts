import type { TscMerkleProof } from '../spv'

// Captured once (2026-09-27) from WhatsOnChain testnet endpoints, not fetched at test time:
// https://api.whatsonchain.com/v1/bsv/test/block/height/1760059
// https://api.whatsonchain.com/v1/bsv/test/block/0000000004d460ca199266ce201ec3cb435dc7c4727f12380efc5a610505b14e/header
// https://api.whatsonchain.com/v1/bsv/test/tx/5944b1bc7f4a98f1a759b74e3494698a6a7bc17d7861f19b5083e9931bf96027/proof/tsc
// The header endpoint returns parsed fields, not raw hex; headerHex below is the standard
// 80-byte little-endian block header serialization built from those fields, and its sha256d
// (reversed) reproduces blockHash exactly.
export const TESTNET_MERKLE_FIXTURE = {
  transactionId: '5944b1bc7f4a98f1a759b74e3494698a6a7bc17d7861f19b5083e9931bf96027',
  blockHash: '0000000004d460ca199266ce201ec3cb435dc7c4727f12380efc5a610505b14e',
  blockHeight: 1760059,
  merkleRoot: '89828ca24e93eb4cbc725207048204fd1bbed314d1104fbaac9b875f6fc6e34e',
  headerHex: '00000020143b058d8f17542818080e6d257e6e85b9504a4ef2abc2206c52d001000000004ee3c66f5f879bacba4f10d114d3be1bfd048204075272bc4ceb934ea28c82899f93b86a4904151c2697e204',
  proof: {
    index: 1,
    txOrId: '5944b1bc7f4a98f1a759b74e3494698a6a7bc17d7861f19b5083e9931bf96027',
    target: '0000000004d460ca199266ce201ec3cb435dc7c4727f12380efc5a610505b14e',
    nodes: ['95c5e1a010eb36a22fa6f62b9e3f8ba357b50236e38fa878b4161146bafa068d'],
  } satisfies TscMerkleProof,
}
