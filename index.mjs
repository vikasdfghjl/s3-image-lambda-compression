import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectTaggingCommand,
  PutObjectTaggingCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";

const S3 = new S3Client();
const DEST_BUCKET = process.env.DEST_BUCKET;
const SUPPORTED_FORMATS = {
  jpg: true,
  jpeg: true,
  png: true,
  JPG: true,
  JPEG: true,
  PNG: true,
};

export const handler = async (event, context) => {
  const { eventTime, s3 } = event.Records[0];
  const srcBucket = s3.bucket.name;

  // Object key may have spaces or unicode non-ASCII characters
  const srcKey = decodeURIComponent(s3.object.key.replace(/\+/g, " "));
  const ext = srcKey.replace(/^.*\./, "").toLowerCase();

  console.log(`${eventTime} - ${srcBucket}/${srcKey}`);

  if (!SUPPORTED_FORMATS[ext]) {
    console.log(`ERROR: Unsupported file type (${ext})`);
    return {
      statusCode: 400,
      body: `Unsupported file type (${ext})`,
    };
  }

  try {
    // Check if the image has already been compressed
    const taggingResult = await S3.send(
      new GetObjectTaggingCommand({
        Bucket: srcBucket,
        Key: srcKey,
      })
    );

    const tags = taggingResult.TagSet;
    console.log("Current Tags:", tags); // Print current tags

    const compressedTag = tags.find((tag) => tag.Key === "compressed" && tag.Value === "true");

    if (compressedTag) {
      console.log(`Image ${srcBucket}/${srcKey} has already been compressed. Skipping compression.`);
      return {
        statusCode: 200,
        body: `Image ${srcBucket}/${srcKey} has already been compressed. Skipping compression.`,
      };
    }

    // Check the image size
    const headResult = await S3.send(
      new HeadObjectCommand({
        Bucket: srcBucket,
        Key: srcKey,
      })
    );

    const imageSize = headResult.ContentLength;

    if (imageSize < 300 * 1024) {
      console.log(`Image ${srcBucket}/${srcKey} is below 300 KB. Skipping compression but adding the tag "compressed=true".`);

      // Adding a tag to indicate the image has been processed without compression
      await S3.send(
        new PutObjectTaggingCommand({
          Bucket: srcBucket,
          Key: srcKey,
          Tagging: {
            TagSet: [
              {
                Key: "compressed",
                Value: "true",
              },
            ],
          },
        })
      );

      return {
        statusCode: 200,
        body: `Image ${srcBucket}/${srcKey} is below 300 KB. Skipping compression but added the tag "compressed=true".`,
      };
    }

    // Get the image from the source bucket
    const { Body, ContentType } = await S3.send(
      new GetObjectCommand({
        Bucket: srcBucket,
        Key: srcKey,
      })
    );
    const image = await Body.transformToByteArray();

    // Get the original dimensions of the image
    const metadata = await sharp(image).metadata();

    // Reduce the original dimensions by a scale factor of 0.5
    const newWidth = Math.round(metadata.width * 0.5);
    const newHeight = Math.round(metadata.height * 0.5);

    // Resize, compress and retain quality, while preserving orientation
    let outputBuffer;
    if (ext === "jpg" || ext === "jpeg") {
      outputBuffer = await sharp(image)
        .rotate() // Preserve orientation
        .resize(newWidth, newHeight, {fit: "inside"}) // Fit the image within the specified dimensions
        .jpeg({
          quality: 50, // Adjust quality here (higher is better quality)
          chromaSubsampling: "4:2:0", // Less chroma subsampling retains better quality
        })
        .toBuffer();
    } else if (ext === "png") {
      outputBuffer = await sharp(image)
        .rotate() // Preserve orientation
        .resize(newWidth, newHeight, {fit: "inside"}) // Fit the image within the specified dimensions
        .png({
          compressionLevel: 9, // 0 (no compression) to 9 (max compression)
          palette: true, // Use a palette to reduce the number of colors
          colors: 128, // Maximum number of colors to reduce to 128
        })
        .toBuffer();
    }

    // Store the compressed image in the destination bucket
    await S3.send(
      new PutObjectCommand({
        Bucket: DEST_BUCKET,
        Key: srcKey,
        Body: outputBuffer,
        ContentType,
        Tagging: "compressed=true", // Tagging the image as compressed
      })
    );

    // Adding a tag to indicate the image has been processed
    await S3.send(
      new PutObjectTaggingCommand({
        Bucket: srcBucket,
        Key: srcKey,
        Tagging: {
          TagSet: [
            {
              Key: "compressed",
              Value: "true",
            },
          ],
        },
      })
    );

    const message = `Successfully resized and compressed ${srcBucket}/${srcKey} and uploaded to ${DEST_BUCKET}/${srcKey}`;
    console.log(message);
    return {
      statusCode: 200,
      body: message,
    };
  } catch (error) {
    console.log(error);
    return {
      statusCode: 500,
      body: "Error occurred while compressing the image.",
    };
  }
};
