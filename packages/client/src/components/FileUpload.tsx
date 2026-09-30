import React, { forwardRef } from 'react';

type FileUploadProps = {
  className?: string;
  onClick?: () => void;
  children: React.ReactNode;
  handleFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
};

const FileUpload: React.ForwardRefExoticComponent<
  FileUploadProps & React.RefAttributes<HTMLInputElement>
> = forwardRef<HTMLInputElement, FileUploadProps>(({ children, handleFileChange }, ref) => {
  return (
    <>
      {children}
      <input
        ref={ref}
        multiple
        type="file"
        // Keep the picker in the render tree for Safari's native file-dialog activation.
        // Avoid display:none: menu-triggered input.click() may otherwise be ignored.
        className="absolute h-px w-px overflow-hidden opacity-0 pointer-events-none"
        tabIndex={-1}
        onChange={handleFileChange}
      />
    </>
  );
});

FileUpload.displayName = 'FileUpload';

export default FileUpload;
