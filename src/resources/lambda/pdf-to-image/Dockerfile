FROM public.ecr.aws/lambda/python:3.12

# Install Poppler for PDF to image conversion
RUN dnf install -y poppler-utils && dnf clean all

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY lambda.py ${LAMBDA_TASK_ROOT}/

CMD ["lambda.handler"]
