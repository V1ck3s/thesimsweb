# Niotso wiki snapshot — RefPack

> Source: <http://wiki.niotso.org/RefPack>  
> Snapshot: 2026-05-01. Cleaned from HTML.

| Type of format | Compression |
|---|---|
| First appeared | Need For Speed II (1997) |
| Contained by | Stream, FAR, DBPF |
**RefPack** is an LZ77/LZSS compression format made by Frank Barchard of EA Canada for the Gimex library used by many older games by EA. In The Sims Online, RefPack bitstreams are held in Stream files. In Need For Speed II SE, the first game to use RefPack, RefPack data is found in Gimex (GMX) files, and in Command & Conquer 3, this data is found in BIG files. Other games may keep RefPack-compressed data in standalone files with no container.

KUDr is credited with reverse-engineering RefPack for Command & Conquer 3.

The values for RefPack are occasionally tweaked on a per-game basis (as observed in SimCity 4). The Sims Online uses the normal values defined in EA's default implementation of RefPack: it is these values that are described in this article.

Here is a safe reimplementation of the function:

struct scanner {
	uint8_t *start;
	uint8_t *ptr;
	uint8_t *end;
	uint8_t overflow;
};
 
static __inline size_t position(const struct scanner *ctx)
{
	return (size_t)(ctx->ptr - ctx->start);
}
 
static __inline size_t remaining(const struct scanner *ctx)
{
	return (size_t)(ctx->end - ctx->ptr);
}
 
static __inline uint8_t overflowed(const struct scanner *ctx)
{
	return ctx->overflow;
}
 
static __inline void scanner_init(struct scanner *ctx, uint8_t *start,
	size_t size)
{
	ctx->start = ctx->ptr = start;
	ctx->end = start + size;
	ctx->overflow = 0;
}
 
static uint8_t read_u8(struct scanner *ctx)
{
	if (ctx->end == ctx->ptr) {
		ctx->overflow = 1;
		return 0;
	}
	return *(ctx->ptr++);
}
 
static uint16_t read_u16(struct scanner *ctx)
{
	uint16_t x;
	if (remaining(ctx) < 2) {
		ctx->ptr = ctx->end, ctx->overflow = 1;
		return 0;
	}
	x = (ctx->ptr[0] << 8) | ctx->ptr[1];
	ctx->ptr += 2;
	return x;
}
 
static uint32_t read_u24(struct scanner *ctx)
{
	uint32_t x;
	if (remaining(ctx) < 3) {
		ctx->ptr = ctx->end, ctx->overflow = 1;
		return 0;
	}
	x = (ctx->ptr[0] << 16) | (ctx->ptr[1] << 8) | ctx->ptr[2];
	ctx->ptr += 3;
	return x;
}
 
static void append(struct scanner *out, struct scanner *in, size_t length)
{
	if (!length)
		return;
	else if (length > 4)
		length = 4;
 
	if (remaining(in) < length || remaining(out) < length) {
		if (remaining(in) < length)
			in->ptr = in->end, in->overflow = 1;
		if (remaining(out) < length)
			out->ptr = out->end, out->overflow = 1;
		return;
	}
 
	memcpy(out->ptr, in->ptr, length);
	out->ptr += length, in->ptr += length;
}
 
static void self_copy(struct scanner *ctx, size_t distance, size_t length)
{
	size_t i;
	uint8_t *in_ptr, *out_ptr;
 
	if (position(ctx) < distance || remaining(ctx) < length) {
		ctx->ptr = ctx->end, ctx->overflow = 1;
		return;
	}
 
	in_ptr = ctx->ptr - distance, out_ptr = ctx->ptr;
	/* neither memcpy nor memmove implement an LZ77 overlapping copy; a
	** one-byte-at-a-time copy is the most efficient thing which does what
	** we want */
	for (i = 0; i < length; i++)
		*out_ptr++ = *in_ptr++;
	ctx->ptr += length;
}
 
/**
 * @brief Decompress a RefPack bitstream
 * @param indata - Pointer to the input RefPack bitstream
 * @param insize - Size of RefPack bitstream
 * @param bytes_read_out - (optional) Pointer to a size_t which will be filled
 *	with the total number of bytes read from the RefPack bitstream; may be
 *	NULL
 * @param outdata - Pointer to the output buffer which will be filled with the
 *	decompressed data
 * @param outsize - Size of output buffer
 * @param bytes_written_out - (optional) Pointer to a size_t which will be
 *	filled with the total number of bytes written to the output buffer; may
 *	be NULL
 * @param compressed_size_out - (optional) Pointer to a uint32_t which will be
 *	set to the "compressed size" field in the RefPack bitstream
 * @param decompressed_size_out - (optional) Pointer to a uint32_t which will be
 *	set to the "decompressed size" field in the RefPack bitstream
 * @return 0 on success; -1 on read overflow of the input buffer; and -2 on
 *	read/write overflow of the output buffer. As an input overflow can
 *	*cause* an output overflow, an input overflow is considered more
 *	significant by this function and takes precedence in the return value;
 *	thus, if both an input overflow and an output overflow occur, this
 *	function returns -1.
 *
 * This is a safe reimplementation of refpack_decompress_unsafe.
 */
int refpack_decompress_safe(const uint8_t *indata, size_t insize,
	size_t *bytes_read_out, uint8_t *outdata, size_t outsize,
	size_t *bytes_written_out, uint32_t *compressed_size_out,
	uint32_t *decompressed_size_out)
{
	struct scanner in, out;
	uint16_t signature;
	uint32_t compressed_size, decompressed_size;
	uint8_t byte_0, byte_1, byte_2, byte_3;
	uint32_t proc_len, ref_dis, ref_len;
 
	scanner_init(&in, (uint8_t*)indata, insize);
	scanner_init(&out, outdata, outsize);
 
	signature = read_u16(&in);
	compressed_size = (signature & 0x0100) ? read_u24(&in) : 0;
	if (compressed_size_out)
		*compressed_size_out = compressed_size;
 
	decompressed_size = read_u24(&in);
	if (decompressed_size_out)
		*decompressed_size_out = decompressed_size;
 
	while (!overflowed(&in) && !overflowed(&out)) {
		byte_0 = read_u8(&in);
		if (!(byte_0 & 0x80)) {
			/* 2-byte command: 0DDRRRPP DDDDDDDD */
			byte_1 = read_u8(&in);
 
			proc_len = byte_0 & 0x03;
			append(&out, &in, proc_len);
 
			ref_dis = ((byte_0 & 0x60) << 3) + byte_1 + 1;
			ref_len = ((byte_0 >> 2) & 0x07) + 3;
			self_copy(&out, ref_dis, ref_len);
		} else if(!(byte_0 & 0x40)) {
			/* 3-byte command: 10RRRRRR PPDDDDDD DDDDDDDD */
			byte_1 = read_u8(&in);
			byte_2 = read_u8(&in);
 
			proc_len = byte_1 >> 6;
			append(&out, &in, proc_len);
 
			ref_dis = ((byte_1 & 0x3f) << 8) + byte_2 + 1;
			ref_len = (byte_0 & 0x3f) + 4;
			self_copy(&out, ref_dis, ref_len);
		} else if(!(byte_0 & 0x20)) {
			/* 4-byte command: 110DRRPP DDDDDDDD DDDDDDDD RRRRRRRR*/
			byte_1 = read_u8(&in);
			byte_2 = read_u8(&in);
			byte_3 = read_u8(&in);
 
			proc_len = byte_0 & 0x03;
			append(&out, &in, proc_len);
 
			ref_dis = ((byte_0 & 0x10) << 12)
				+ (byte_1 << 8) + byte_2 + 1;
			ref_len = ((byte_0 & 0x0c) << 6) + byte_3 + 5;
			self_copy(&out, ref_dis, ref_len);
		} else {
			/* 1-byte command */
			proc_len = (byte_0 & 0x1f) * 4 + 4;
			if (proc_len <= 0x70) {
				/* no stop flag */
				append(&out, &in, proc_len);
			} else {
				/* stop flag */
				proc_len = byte_0 & 0x3;
				append(&out, &in, proc_len);
 
				break;
			}
		}
	}
 
	if (bytes_read_out)
		*bytes_read_out = position(&in);
	if (bytes_written_out)
		*bytes_written_out = position(&out);
 
	if (overflowed(&in))
		return -1;
	else if (overflowed(&out))
		return -2;
	else
		return 0;
}
## Bitstream specification

In this article, bytes are rendered in big-endian bit order, that is, from the most significant bit of the first byte to the least significant bit of the first byte, followed by the most significant bit of the second byte, and so on.

### Header

The RefPack header begins with a 1-byte Flags field, followed by a 1-byte magic number equal to 0xFB:

| Byte 1 | Byte 2 |
|---|---|
| LU01000C | 11111011 |

The large-files flag ("L") specifies that the decompressed field and (if applicable) the compressed size field are 4-byte fields; if this flag is unset, both of these fields are 3-byte fields. The unknown flag ("U") is currently unknown. The compressed-size-present flag ("C") specifies that the compressed size field is present.

Note that The Sims Online only recognizes the compressed-size-present flag; the large-files flag and the unknown flag were not introduced until SimCity 4 and Command & Conquer 3.

Afterwards, if the compressed-size-present flag is both set and recognized by the decoder, the compressed size field follows in big-endian format. It is unknown if this field starts counting from the beginning of the RefPack bitstream or from after this field, because no file in the game specifies this field, and the game appears to always ignore this field.

Afterwards, the decompressed size field follows in big-endian format.

### Commands

Following the header is a series of commands, each containing a 1- to 4-byte opcode followed by its proceeding data.

Each opcode specifies three parameters:

-  **Proceeding data length** - The length of the data that follows the opcode and which is to be appended to the output buffer; this data is called the proceeding data.
-  **Referenced data length** - The length of the data which is to be copied one byte at a time from earlier in the output buffer and appended to the output buffer directly after the proceeding data; this data is called the referenced data.
-  **Referenced data distance** - The distance to the beginning of the referenced data from the current position in the output buffer, after the proceeding data.

Like any other LZ77 algorithm, the referenced data's source pointer may overrun into the initial value of the destination pointer. This happens when *Referenced data length* is longer than *Referenced data distance*. This is considered legal: in this case, the decoder shall copy one byte at a time, or, equivalently, the decoder shall copy and paste the first *Referenced data length* bytes of the referenced data repeatedly until the correct length is met.

The *Referenced data distance* field of any command must not be greater than the total number of bytes in the output buffer at the time of the reference copy. (If this rule is violated, the decoder in The Sims Online will break.)

Additionally, the stop command terminates the decoder after the command's proceeding data has been copied. The stop command must appear exactly once after all ordinary (non-stop) commands. (If the stop command does not appear, the decoder in The Sims Online will break.)

SimCity 4 uses a modified definition for the 4-byte opcode; it appears that this is the only game to use a modified version of RefPack.

| Key | Notes |
|---|---|
| `#` | Opcode identifier bit |
| `P` | Proceeding Data Length bit |
| `R` | Referenced Data Length bit |
| `D` | Referenced Data Distance bit |

To obtain the values of any opcode, just merge the bits associated with that value in the order that they appear, with exceptions where noted.

The opcode identifier bits use unary coding.

#### 2-byte command

| Byte 1 | Byte 2 |
|---|---|
| 0DDRRRPP | DDDDDDDD |

| Value | Range | Expression | Exception to simple merging |
|---|---|---|---|
| Proceeding Data Length | 0 to 3 | `Byte1 & 0x03` | None |
| Referenced Data Length | 3 to 10 | `((Byte1 & 0x1C) >> 2) + 3` | Add 3 to the extracted value |
| Referenced Data Distance | 1 to 1024 | `((Byte1 & 0x60) << 3) + Byte2 + 1` | Add 1 to the extracted value |

#### 3-byte command

| Byte 1 | Byte 2 | Byte 3 |
|---|---|---|
| 10RRRRRR | PPDDDDDD | DDDDDDDD |

| Value | Range | Expression | Exception to simple merging |
|---|---|---|---|
| Proceeding Data Length | 0 to 3 | `(Byte2 & 0xC0) >> 6` | None |
| Referenced Data Length | 4 to 67 | `(Byte1 & 0x3F) + 4` | Add 4 to the extracted value |
| Referenced Data Distance | 1 to 16384 | `((Byte2 & 0x3F) << 8) + Byte3 + 1` | Add 1 to the extracted value |

#### 4-byte command

| Byte 1 | Byte 2 | Byte 3 | Byte 4 |
|---|---|---|---|
| 110DRRPP | DDDDDDDD | DDDDDDDD | RRRRRRRR |

| Value | Range | Expression | Exception to simple merging |
|---|---|---|---|
| Proceeding Data Length | 0 to 3 | `Byte1 & 0x03` | None |
| Referenced Data Length | 5 to 1028 | `((Byte1 & 0x0C) << 6) + Byte4 + 5` | Add 5 to the extracted value |
| Referenced Data Distance | 1 to 131072 | `((Byte1 & 0x10) << 12) + (Byte2 << 8) + Byte3 + 1` | Add 1 to the extracted value |

#### 1-byte command

| Byte 1 |
|---|
| 111PPPPP |

The 1-byte command follows one of two definitions: the ordinary 1-byte command and the stop command.

If the numerical value of the opcode byte is less than 0xFC, then the command is the ordinary 1-byte command and follows this format:

| Value | Range | Expression | Exception to simple merging |
|---|---|---|---|
| Proceeding Data Length | 4 to 112 in steps of 4 | `((Byte1 & 0x1F) + 1) << 2` | Add 1 to the extracted value and then multiply by 4 |
| Referenced Data Length | 0 | 0 | n/a |
| Referenced Data Distance | 0 | 0 | n/a |

Otherwise, if the numerical value of the opcode is greater than or equal to 0xFC, then the command is the stop command and follows this format:

| Value | Range | Expression | Exception to simple merging |
|---|---|---|---|
| Proceeding Data Length | 0 to 3 | `Byte1 & 0x03` | None |
| Referenced Data Length | 0 | 0 | n/a |
| Referenced Data Distance | 0 | 0 | n/a |

## Naming notes

The original RefPack.cpp written by Frank Barchard was released by WCNews: http://download.wcnews.com/files/documents/sourcecode/shadowforce/transfer/asommers/mfcapp_src/engine/compress/RefPack.cpp

In The Sims Online, this file was split into refencode.cpp and refdecode.cpp, according to TSOGimexD.dll, although these files have not been leaked.
