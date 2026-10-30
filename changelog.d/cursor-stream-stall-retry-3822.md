### Fixed

- A provider turn that loses its stream before any answer now tries the prompt again. A dropped connection, a short overload, or a silent start that the agent cancels is sent again, up to four times. A turn that already showed text or a tool call is not sent again. A sign-in error is not sent again. A silent turn that the agent does not cancel still fails with the stall message.
